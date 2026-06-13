import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDoc, collection, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../../firebase/firebase.js';

const SYSTEM_SETTINGS_REF = doc(db, 'settings', 'system');
const AUTOMATION_STATUS_REF = doc(db, 'automation', 'status');
const ESP_DEVICE_REF = doc(db, 'devices', 'esp-main-01');
const ESP_DEVICE_ID = 'esp-main-01';
const TOTAL_MOVEMENT_POSITIONS = 18;
const ONLINE_WINDOW_MS = 30000;

const SORTING_OPTIONS = [
  { value: '', label: 'Select strategy' },
  { value: 'brand', label: 'Brand' },
  { value: 'model', label: 'Model' },
  { value: 'size', label: 'Size' },
  { value: 'color', label: 'Color' },
  { value: 'brand_size', label: 'Brand + Size' },
  { value: 'model_size', label: 'Model + Size' },
  { value: 'color_size', label: 'Color + Size' },
];

const DEFAULT_SETTINGS = {
  sortingMode: '',
  automationEnabled: false,
  autoConveyor: true,
  autoOCR: true,
  autoPositionSelection: true,
  autoInventoryUpdate: true,
  requireIRVerification: false,
  firebaseLogging: true,
};

const DEFAULT_AUTOMATION_STATUS = {
  automationStarted: false,
  sortingStrategy: '',
  currentState: 'WAIT_FOR_AUTOMATION',
  cameraBusy: false,
  beltRunning: false,
  beltBlocked: true,
  lifterBusy: false,
  currentOperation: '',
  lastError: null,
};

const AUTOMATION_OPTIONS = [
  { key: 'autoConveyor', label: 'Auto Conveyor' },
  { key: 'autoOCR', label: 'Auto OCR' },
  { key: 'autoPositionSelection', label: 'Auto Position Selection' },
  { key: 'autoInventoryUpdate', label: 'Auto Inventory Update' },
  { key: 'requireIRVerification', label: 'IR Placement Verification' },
  { key: 'firebaseLogging', label: 'Firebase Logging' },
];

function logWebsiteActivity(activityType, message) {
  const data = {
    type: activityType,
    activityType,
    message,
    source: 'website',
    sourceDevice: 'website',
    status: 'info',
    createdAt: serverTimestamp(),
  };
  return Promise.all([
    addDoc(collection(db, 'systemActivity'), data),
    addDoc(collection(db, 'activityLog'), data),
  ]);
}

async function createAutomationCommand(command) {
  const commandRef = doc(collection(db, 'commands'));
  const commandId = commandRef.id;

  await setDoc(commandRef, {
    command,
    status: 'pending',
    deviceId: ESP_DEVICE_ID,
    createdAt: serverTimestamp(),
    commandId,
  });

  const createdCommand = await getDoc(commandRef);
  if (!createdCommand.exists()) {
    throw new Error(`${command} command was not created in Firestore.`);
  }

  return commandId;
}

function getDateValue(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (value.toMillis) return new Date(value.toMillis());
  if (value instanceof Date) return value;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getTimestampMs(value) {
  return getDateValue(value)?.getTime() || 0;
}

function formatDate(value) {
  const date = getDateValue(value);
  if (!date) return '--';

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function isRecent(value) {
  const timestamp = getTimestampMs(value);
  return Boolean(timestamp && Date.now() - timestamp <= ONLINE_WINDOW_MS);
}

function normalizeStatus(value, fallback = 'Offline') {
  if (!value) return fallback;
  const normalized = String(value).replaceAll('_', ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getScanTimestamp(scan) {
  return scan?.createdAt || scan?.updatedAt || scan?.timestamp || scan?.scanTime;
}

function getSelectedMovement(scan) {
  const directPosition = Number(scan?.position || scan?.selectedPosition);
  if (directPosition >= 1 && directPosition <= TOTAL_MOVEMENT_POSITIONS) return `GO ${directPosition}`;

  const physicalLocation = Number(scan?.selectedLocation || scan?.location);
  if (physicalLocation >= 1 && physicalLocation <= 9) return `GO ${physicalLocation * 2 - 1}`;

  if (scan?.arduinoCommand) return scan.arduinoCommand;
  return '--';
}

function normalize(value) {
  return String(value || '').trim().toUpperCase();
}

function productKeyFromParts(parts) {
  return ['brand', 'model', 'color', 'size'].map((field) => normalize(parts[field])).join('|');
}

function locationIdOf(location) {
  return Number(location.locationId || location.position || location.id);
}

function isRetrievableLocation(location) {
  const id = locationIdOf(location);
  return Number.isInteger(id) && id >= 1 && id <= 9 && location.status === 'full' && Boolean(location.boxId);
}

function queueCounts(items) {
  return {
    waiting: items.filter((item) => item.status === 'waiting').length,
    running: items.filter((item) => item.status === 'running').length,
    done: items.filter((item) => item.status === 'done').length,
    error: items.filter((item) => item.status === 'error').length,
  };
}

function AdminControlPanel() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [sortingMode, setSortingMode] = useState(DEFAULT_SETTINGS.sortingMode);
  const [locations, setLocations] = useState([]);
  const [latestScan, setLatestScan] = useState(null);
  const [storeQueue, setStoreQueue] = useState([]);
  const [pickQueue, setPickQueue] = useState([]);
  const [scanQueue, setScanQueue] = useState([]);
  const [orderQueue, setOrderQueue] = useState([]);
  const [automationStatus, setAutomationStatus] = useState(DEFAULT_AUTOMATION_STATUS);
  const [espDevice, setEspDevice] = useState(null);
  const [products, setProducts] = useState([]);
  const [quickRetrieve, setQuickRetrieve] = useState({ brand: '', model: '', color: '', size: '' });
  const [productSearch, setProductSearch] = useState('');
  const [advancedBoxId, setAdvancedBoxId] = useState('');
  const [firebaseOnline, setFirebaseOnline] = useState(false);
  const [saving, setSaving] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const commandRequestInFlight = useRef(false);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      SYSTEM_SETTINGS_REF,
      (snapshot) => {
        const nextSettings = {
          ...DEFAULT_SETTINGS,
          ...(snapshot.exists() ? snapshot.data() : {}),
        };
        setSettings(nextSettings);
        setSortingMode(nextSettings.sortingMode || DEFAULT_SETTINGS.sortingMode);
        setFirebaseOnline(true);
        setError('');
      },
      () => {
        setFirebaseOnline(false);
        setError('Unable to read automation settings from Firestore.');
      },
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      AUTOMATION_STATUS_REF,
      (snapshot) => {
        setAutomationStatus({
          ...DEFAULT_AUTOMATION_STATUS,
          ...(snapshot.exists() ? snapshot.data() : {}),
        });
      },
      () => setAutomationStatus(DEFAULT_AUTOMATION_STATUS),
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      ESP_DEVICE_REF,
      (snapshot) => setEspDevice(snapshot.exists() ? snapshot.data() : null),
      () => setEspDevice(null),
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribeLocations = onSnapshot(
      collection(db, 'locations'),
      (snapshot) => {
        setLocations(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      },
      () => setLocations([]),
    );

    const scansQuery = query(collection(db, 'scans'), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribeScans = onSnapshot(
      scansQuery,
      (snapshot) => {
        setLatestScan(snapshot.docs[0] ? { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } : null);
      },
      () => setLatestScan(null),
    );

    const storeQueueQuery = query(collection(db, 'storeQueue'), orderBy('updatedAt', 'desc'), limit(25));
    const unsubscribeStoreQueue = onSnapshot(
      storeQueueQuery,
      (snapshot) => setStoreQueue(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setStoreQueue([]),
    );

    const pickQueueQuery = query(collection(db, 'pickQueue'), orderBy('updatedAt', 'desc'), limit(25));
    const unsubscribePickQueue = onSnapshot(
      pickQueueQuery,
      (snapshot) => setPickQueue(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setPickQueue([]),
    );

    const scanQueueQuery = query(collection(db, 'scanQueue'), orderBy('updatedAt', 'desc'), limit(25));
    const unsubscribeScanQueue = onSnapshot(
      scanQueueQuery,
      (snapshot) => setScanQueue(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setScanQueue([]),
    );

    const orderQueueQuery = query(collection(db, 'pickRequests'), orderBy('updatedAt', 'desc'), limit(25));
    const unsubscribeOrderQueue = onSnapshot(
      orderQueueQuery,
      (snapshot) => setOrderQueue(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setOrderQueue([]),
    );

    const productsQuery = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
    const unsubscribeProducts = onSnapshot(
      productsQuery,
      (snapshot) => setProducts(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setProducts([]),
    );

    return () => {
      unsubscribeLocations();
      unsubscribeScans();
      unsubscribeStoreQueue();
      unsubscribePickQueue();
      unsubscribeScanQueue();
      unsubscribeOrderQueue();
      unsubscribeProducts();
    };
  }, []);

  const warehouseSummary = useMemo(() => {
    const physicalLocations = Array.from({ length: 9 }, (_, index) => {
      const locationId = index + 1;
      return locations.find((location) => Number(location.position || location.id) === locationId);
    });
    const occupied = physicalLocations.filter((location) => location?.status === 'full' || location?.isOccupied).length;

    return {
      total: 9,
      occupied,
      empty: 9 - occupied,
    };
  }, [locations]);

  const queueSummary = useMemo(() => {
    return {
      store: queueCounts(storeQueue),
      pick: queueCounts(pickQueue),
    };
  }, [pickQueue, storeQueue]);

  const currentOperation = useMemo(() => {
    const runningPick = pickQueue.find((item) => item.status === 'running');
    const runningStore = storeQueue.find((item) => item.status === 'running');
    const active = runningPick || runningStore;
    if (!active) return null;
    return {
      type: runningPick ? 'GET' : 'PUT',
      locationId: active.locationId,
      movement: active.outPosition ? `GO ${active.outPosition}` : active.inPosition ? `GO ${active.inPosition}` : active.goPosition ? `GO ${active.goPosition}` : '--',
    };
  }, [pickQueue, storeQueue]);

  const lifterStatus = automationStatus.lifterBusy || currentOperation ? 'Working' : automationStatus.lastError ? 'Error' : 'Idle';
  const selectedStrategy = automationStatus.sortingStrategy || sortingMode;
  const missingStrategy = !selectedStrategy;

  const productResults = useMemo(() => {
    const term = productSearch.trim().toLowerCase();
    if (!term) return products.slice(0, 8);
    return products
      .filter((product) => [
        product.productKey,
        product.brand,
        product.model,
        product.color,
        product.size,
        product.name,
      ].some((value) => String(value || '').toLowerCase().includes(term)))
      .slice(0, 12);
  }, [productSearch, products]);

  const updateSettings = async (updates, actionLabel) => {
    setSaving(actionLabel);
    setError('');
    setNotice('');

    try {
      await setDoc(SYSTEM_SETTINGS_REF, {
        ...updates,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setNotice(`${actionLabel} saved.`);
    } catch {
      setError(`Unable to save ${actionLabel}.`);
    } finally {
      setSaving('');
    }
  };

  const handleAutomationToggle = async (enabled) => {
    if (commandRequestInFlight.current) return;

    const actionLabel = enabled ? 'Start Automation' : 'Stop Automation';
    const command = enabled ? 'START_AUTOMATION' : 'STOP_AUTOMATION';
    commandRequestInFlight.current = true;
    setSaving(actionLabel);
    setError('');
    setNotice('');

    try {
      const commandId = await createAutomationCommand(command);
      console.log(`${command} sent`);

      await Promise.all([
        setDoc(SYSTEM_SETTINGS_REF, {
          automationEnabled: enabled,
          sortingMode,
          lastControlAction: command,
          controlRequestedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: true }),
        setDoc(AUTOMATION_STATUS_REF, {
          automationStarted: enabled,
          sortingStrategy: sortingMode,
          currentState: enabled ? 'WAIT_BOX_AT_CAMERA' : 'STOPPED',
          cameraBusy: false,
          beltRunning: false,
          beltBlocked: !enabled,
          lifterBusy: false,
          currentOperation: '',
          lastError: enabled ? null : 'Stopped by operator',
          updatedAt: serverTimestamp(),
        }, { merge: true }),
        logWebsiteActivity(
          enabled ? 'AUTOMATION_STARTED' : 'AUTOMATION_STOPPED',
          enabled ? `Automation started with ${sortingMode || 'no sorting strategy selected'}.` : 'Automation stopped by operator.',
        ),
      ]);

      setNotice(`${actionLabel} command sent. Command ID: ${commandId}`);
    } catch (requestError) {
      setError(requestError.message || `Unable to ${enabled ? 'start' : 'stop'} automation.`);
    } finally {
      commandRequestInFlight.current = false;
      setSaving('');
    }
  };

  const handleSortingSave = () => {
    if (!sortingMode) {
      setError('Choose a sorting strategy first.');
      return;
    }
    setSaving('Sorting Strategy');
    setError('');
    setNotice('');
    Promise.all([
      setDoc(SYSTEM_SETTINGS_REF, {
        sortingMode,
        updatedAt: serverTimestamp(),
      }, { merge: true }),
      setDoc(AUTOMATION_STATUS_REF, {
        sortingStrategy: sortingMode,
        currentState: automationStatus.automationStarted ? 'WAIT_BOX_AT_CAMERA' : 'WAIT_FOR_AUTOMATION',
        lastError: null,
        updatedAt: serverTimestamp(),
      }, { merge: true }),
    ])
      .then(() => setNotice('Sorting Strategy saved.'))
      .catch(() => setError('Unable to save Sorting Strategy.'))
      .finally(() => setSaving(''));
  };

  const handleOptionChange = (key, checked) => {
    setSettings((current) => ({ ...current, [key]: checked }));
    updateSettings({ [key]: checked }, key);
  };

  const handleEmergencyAction = (action) => {
    if (action === 'EMERGENCY_STOP') {
      handleAutomationToggle(false);
      return;
    }
    updateSettings({
      automationEnabled: settings.automationEnabled,
      emergencyStop: false,
      lastControlAction: action,
      controlRequestedAt: serverTimestamp(),
    }, action.replaceAll('_', ' '));
  };

  const handleClearError = async () => {
    setSaving('Clear Error');
    setError('');
    setNotice('');
    try {
      await setDoc(AUTOMATION_STATUS_REF, {
        currentState: automationStatus.automationStarted ? 'WAIT_BOX_AT_CAMERA' : 'WAIT_FOR_AUTOMATION',
        beltBlocked: !automationStatus.automationStarted,
        beltRunning: false,
        cameraBusy: false,
        lifterBusy: false,
        currentOperation: '',
        lastError: null,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setNotice('Automation error cleared.');
    } catch {
      setError('Unable to clear automation error.');
    } finally {
      setSaving('');
    }
  };

  const createPickRequestForLocation = async (location, source = 'retrieval-panel') => {
    const locationId = locationIdOf(location);
    if (!isRetrievableLocation(location)) {
      throw new Error(`Location ${locationId || '-'} is not full.`);
    }
    await addDoc(collection(db, 'pickRequests'), {
      requestType: 'location',
      queryValue: String(locationId),
      locationId,
      boxId: location.boxId,
      productKey: location.productKey || productKeyFromParts(location),
      brand: normalize(location.brand),
      model: normalize(location.model),
      color: normalize(location.color),
      size: normalize(location.size),
      status: 'waiting',
      source,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  };

  const handleRetrieveLocations = async (matchingLocations, label) => {
    if (matchingLocations.length === 0) {
      setError(`No full locations found for ${label}.`);
      return;
    }
    setSaving(label);
    setError('');
    setNotice('');

    try {
      await Promise.all(matchingLocations.map((location) => createPickRequestForLocation(location)));
      setNotice(`${matchingLocations.length} retrieval task${matchingLocations.length === 1 ? '' : 's'} sent to Raspberry Pi.`);
    } catch (requestError) {
      setError(requestError.message || 'Unable to create retrieval request.');
    } finally {
      setSaving('');
    }
  };

  const handleQuickRetrieve = (event) => {
    event.preventDefault();
    const wantedKey = productKeyFromParts(quickRetrieve);
    const matches = locations.filter((location) =>
      isRetrievableLocation(location) &&
      normalize(location.productKey || productKeyFromParts(location)) === wantedKey,
    );
    handleRetrieveLocations(matches, wantedKey);
  };

  const handleRetrieveLocation = (locationId) => {
    const location = locations.find((item) => locationIdOf(item) === locationId);
    handleRetrieveLocations(location ? [location] : [], `Location ${locationId}`);
  };

  const handleRetrieveProduct = (product) => {
    const key = product.productKey || productKeyFromParts(product);
    const matches = locations.filter((location) =>
      isRetrievableLocation(location) &&
      normalize(location.productKey || productKeyFromParts(location)) === normalize(key),
    );
    handleRetrieveLocations(matches, key);
  };

  const handleAdvancedBoxRetrieve = async (event) => {
    event.preventDefault();
    const value = advancedBoxId.trim();
    if (!value) {
      setError('Enter a Box ID.');
      return;
    }
    setSaving('Advanced Box Retrieval');
    setError('');
    setNotice('');
    try {
      await addDoc(collection(db, 'pickRequests'), {
        requestType: 'single',
        queryValue: value,
        status: 'waiting',
        source: 'advanced',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setAdvancedBoxId('');
      setNotice('Advanced Box ID retrieval request sent.');
    } catch {
      setError('Unable to create advanced retrieval request.');
    } finally {
      setSaving('');
    }
  };

  return (
    <div className="admin-control-page">
      <section className="admin-page-heading control-hero">
        <div>
          <p className="section-eyebrow">Automation console</p>
          <h1>Warehouse Automation Control Center</h1>
          <p>Manage automated scanning, sorting, lifter movement, and inventory synchronization.</p>
        </div>
        <span className={`control-mode-pill ${automationStatus.automationStarted ? 'enabled' : 'disabled'}`}>
          {automationStatus.automationStarted ? 'Automation Enabled' : 'Automation Disabled'}
        </span>
      </section>

      {error && <p className="admin-form-error">{error}</p>}
      {notice && <p className="admin-form-success">{notice}</p>}

      <section className="control-system-card">
        <div className="control-card-heading">
          <div>
            <p className="section-eyebrow">System Control</p>
            <h2>System Status</h2>
          </div>
          <div className="control-actions">
            <button
              className="button button-primary"
              type="button"
              onClick={() => handleAutomationToggle(true)}
              disabled={Boolean(saving)}
            >
              {saving === 'Start Automation' ? 'Starting...' : 'Start Automation'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => handleAutomationToggle(false)}
              disabled={Boolean(saving)}
            >
              {saving === 'Stop Automation' ? 'Stopping...' : 'Stop Automation'}
            </button>
          </div>
        </div>

        <div className="control-system-grid">
          <div className="automation-status-panel">
            <span>Automation Status</span>
            <strong className={automationStatus.automationStarted ? 'enabled' : 'disabled'}>
              {automationStatus.automationStarted ? 'Enabled' : 'Disabled'}
            </strong>
            <p>{missingStrategy ? 'Waiting for sorting strategy.' : firebaseOnline ? 'Settings synced with Firestore.' : 'Waiting for Firestore settings.'}</p>
          </div>
          <div className="control-detail-grid">
            <div>
              <span>Current Sorting Mode</span>
              <strong>{SORTING_OPTIONS.find((option) => option.value === selectedStrategy)?.label || 'Waiting'}</strong>
            </div>
            <div>
              <span>Lifter Status</span>
              <strong>{lifterStatus}</strong>
            </div>
            <div>
              <span>Current State</span>
              <strong>{automationStatus.currentState || 'WAIT_FOR_AUTOMATION'}</strong>
            </div>
            <div>
              <span>Current Operation</span>
              <strong>{automationStatus.currentOperation || (currentOperation ? `${currentOperation.type} ${currentOperation.movement}` : '--')}</strong>
            </div>
            <div>
              <span>Belt</span>
              <strong>{automationStatus.beltRunning ? 'Running' : 'Stopped'} / {automationStatus.beltBlocked ? 'Blocked' : 'Clear'}</strong>
            </div>
            <div>
              <span>Camera</span>
              <strong>{automationStatus.cameraBusy ? 'Reading' : 'Idle'}</strong>
            </div>
            <div>
              <span>Last Error</span>
              <strong>{automationStatus.lastError || '--'}</strong>
            </div>
            <div>
              <span>IR Camera</span>
              <strong>{espDevice?.irCamera ? 'Detected' : 'Clear'}</strong>
            </div>
            <div>
              <span>IR Lifter</span>
              <strong>{espDevice?.irLifter ? 'Detected' : 'Clear'}</strong>
            </div>
            <div>
              <span>Ultrasonic Ready</span>
              <strong>{espDevice?.ultrasonicReady ? 'Ready' : 'Not Ready'}</strong>
            </div>
            <div>
              <span>Location 8 IR</span>
              <strong>{espDevice?.loc8Detected ? 'Detected' : 'Clear'}</strong>
            </div>
            <div>
              <span>Location 9 IR</span>
              <strong>{espDevice?.loc9Detected ? 'Detected' : 'Clear'}</strong>
            </div>
          </div>
          <button className="button button-secondary" type="button" onClick={handleClearError} disabled={Boolean(saving)}>
            Clear Error
          </button>
        </div>
      </section>

      <section className="control-dashboard-grid">
        <article className="control-card">
          <div className="control-card-heading compact">
            <h2>Sorting Strategy</h2>
          </div>
          <label className="control-field" htmlFor="sorting-mode">
            <span>Mode</span>
            <select id="sorting-mode" value={sortingMode} onChange={(event) => setSortingMode(event.target.value)}>
              {SORTING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            className="button button-primary"
            type="button"
            onClick={handleSortingSave}
            disabled={Boolean(saving)}
          >
            Save Configuration
          </button>
        </article>

        <article className="control-card">
          <div className="control-card-heading compact">
            <h2>OCR Monitoring</h2>
          </div>
          <div className="control-detail-grid">
            <div>
              <span>Camera Status</span>
              <strong>{normalizeStatus(latestScan?.cameraStatus || (isRecent(getScanTimestamp(latestScan)) ? 'online' : 'No data'), 'No data')}</strong>
            </div>
            <div>
              <span>OCR Status</span>
              <strong>{normalizeStatus(latestScan?.ocrStatus || latestScan?.status || 'No data')}</strong>
            </div>
            <div>
              <span>Brand</span>
              <strong>{latestScan?.brand || '--'}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{latestScan?.model || '--'}</strong>
            </div>
            <div>
              <span>Color</span>
              <strong>{latestScan?.color || '--'}</strong>
            </div>
            <div>
              <span>Size</span>
              <strong>{latestScan?.size || '--'}</strong>
            </div>
            <div>
              <span>Last Selected Command</span>
              <strong>{getSelectedMovement(latestScan)}</strong>
            </div>
            <div>
              <span>Last Scan Time</span>
              <strong>{formatDate(getScanTimestamp(latestScan))}</strong>
            </div>
          </div>
        </article>
      </section>

      <section className="control-card warehouse-control-card">
        <div className="control-card-heading">
          <div>
            <h2>Warehouse Summary</h2>
            <p>Physical storage overview. Open Locations for the full warehouse grid.</p>
          </div>
          <div className="control-summary-row">
            <span>Total Locations <strong>{warehouseSummary.total}</strong></span>
            <span>Occupied <strong>{warehouseSummary.occupied}</strong></span>
            <span>Empty <strong>{warehouseSummary.empty}</strong></span>
          </div>
        </div>
        <Link className="button button-secondary control-view-locations" to="/admin/locations">
          View Locations
        </Link>
      </section>

      <section className="control-card warehouse-control-card">
        <div className="control-card-heading">
          <div>
            <h2>Retrieval Panel</h2>
            <p>Retrieve by product or location. Box IDs stay in Advanced.</p>
          </div>
        </div>

        <div className="retrieval-panel-grid">
          <article className="retrieval-section">
            <h3>Quick Retrieve</h3>
            <form className="quick-retrieve-grid" onSubmit={handleQuickRetrieve}>
              {['brand', 'model', 'color', 'size'].map((field) => (
                <label className="control-field" htmlFor={`quick-${field}`} key={field}>
                  <span>{field}</span>
                  <input
                    id={`quick-${field}`}
                    value={quickRetrieve[field]}
                    onChange={(event) => setQuickRetrieve((current) => ({ ...current, [field]: event.target.value }))}
                    placeholder={field === 'brand' ? 'NIKE' : field === 'model' ? 'AIR FORCE' : field === 'color' ? 'WHITE' : '40'}
                    type="text"
                  />
                </label>
              ))}
              <button className="button button-primary" type="submit" disabled={Boolean(saving)}>
                Retrieve Matching Boxes
              </button>
            </form>
          </article>

          <article className="retrieval-section">
            <h3>Retrieve By Location</h3>
            <div className="location-retrieve-grid">
              {Array.from({ length: 9 }, (_, index) => index + 1).map((locationId) => {
                const location = locations.find((item) => locationIdOf(item) === locationId);
                return (
                  <button
                    className="button button-secondary"
                    type="button"
                    key={locationId}
                    disabled={Boolean(saving) || !isRetrievableLocation(location || {})}
                    onClick={() => handleRetrieveLocation(locationId)}
                  >
                    Location {locationId}
                  </button>
                );
              })}
            </div>
          </article>

          <article className="retrieval-section retrieval-section-wide">
            <h3>Retrieve By Product</h3>
            <label className="control-field" htmlFor="product-retrieve-search">
              <span>Search brand/model/color/size</span>
              <input
                id="product-retrieve-search"
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="SAMBA, AIR FORCE, 43, WHITE"
                type="search"
              />
            </label>
            <div className="product-retrieve-list">
              {productResults.map((product) => (
                <div className="product-retrieve-row" key={product.id}>
                  <div>
                    <strong>{product.productKey || productKeyFromParts(product)}</strong>
                    <span>{Number(product.availableStock ?? product.quantity ?? 0)} available</span>
                  </div>
                  <button className="button button-secondary" type="button" disabled={Boolean(saving)} onClick={() => handleRetrieveProduct(product)}>
                    Retrieve
                  </button>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="control-dashboard-grid">
        <article className="control-card">
          <div className="control-card-heading compact">
            <h2>Queue Monitor</h2>
          </div>
          <div className="control-detail-grid">
            <div>
              <span>Pick Waiting</span>
              <strong>{queueSummary.pick.waiting}</strong>
            </div>
            <div>
              <span>Pick Running</span>
              <strong>{queueSummary.pick.running}</strong>
            </div>
            <div>
              <span>Pick Done</span>
              <strong>{queueSummary.pick.done}</strong>
            </div>
            <div>
              <span>Store Waiting</span>
              <strong>{queueSummary.store.waiting}</strong>
            </div>
            <div>
              <span>Store Running</span>
              <strong>{queueSummary.store.running}</strong>
            </div>
            <div>
              <span>Store Done</span>
              <strong>{queueSummary.store.done}</strong>
            </div>
          </div>
        </article>

        <article className="control-card">
          <div className="control-card-heading compact">
            <h2>Advanced Retrieval</h2>
          </div>
          <form className="pick-request-form" onSubmit={handleAdvancedBoxRetrieve}>
            <label className="control-field" htmlFor="advanced-box-id">
              <span>Box ID</span>
              <input
                id="advanced-box-id"
                value={advancedBoxId}
                onChange={(event) => setAdvancedBoxId(event.target.value)}
                placeholder="BOX-..."
                type="text"
              />
            </label>
            <button className="button button-primary" type="submit" disabled={Boolean(saving)}>
              Retrieve Box ID
            </button>
          </form>
        </article>
      </section>

      <section className="control-dashboard-grid">
        <article className="control-card">
          <div className="control-card-heading compact">
            <h2>Scan Queue</h2>
          </div>
          <div className="queue-list">
            {scanQueue.length === 0 ? (
              <p className="orders-customer-meta">No cartons waiting for lifter.</p>
            ) : scanQueue.slice(0, 8).map((item) => (
              <div className="queue-row" key={item.id}>
                <strong>{item.productKey || [item.brand, item.model, item.color, item.size].filter(Boolean).join('|')}</strong>
                <span>{item.status || 'WAITING'} / Location {item.targetLocation || '-'}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="control-card">
          <div className="control-card-heading compact">
            <h2>Order Queue</h2>
          </div>
          <div className="queue-list">
            {orderQueue.length === 0 ? (
              <p className="orders-customer-meta">No order retrieval requests.</p>
            ) : orderQueue.slice(0, 8).map((item) => (
              <div className="queue-row" key={item.id}>
                <strong>{item.orderNumber || item.orderId || item.productKey || item.queryValue}</strong>
                <span>{item.status || 'waiting'} / Location {item.locationId || '-'}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="control-dashboard-grid lower">
        <article className="control-card">
          <div className="control-card-heading compact">
            <h2>Automation Settings</h2>
          </div>
          <div className="control-toggle-list">
            {AUTOMATION_OPTIONS.map((option) => (
              <label className="control-toggle" key={option.key}>
                <span>{option.label}</span>
                <input
                  type="checkbox"
                  checked={Boolean(settings[option.key])}
                  onChange={(event) => handleOptionChange(option.key, event.target.checked)}
                />
              </label>
            ))}
          </div>
        </article>

        <article className="control-card danger-card">
          <div className="control-card-heading compact">
            <h2>Emergency Controls</h2>
          </div>
          <div className="emergency-actions">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => handleEmergencyAction('HOME_LIFTER')}
              disabled={Boolean(saving)}
            >
              Home Lifter
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => handleEmergencyAction('RESET_SYSTEM')}
              disabled={Boolean(saving)}
            >
              Reset System
            </button>
            <button
              className="button button-danger"
              type="button"
              onClick={() => handleEmergencyAction('EMERGENCY_STOP')}
              disabled={Boolean(saving)}
            >
              Emergency Stop
            </button>
          </div>
        </article>
      </section>
    </div>
  );
}

export default AdminControlPanel;
