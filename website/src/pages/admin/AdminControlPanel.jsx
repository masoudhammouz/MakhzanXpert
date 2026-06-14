import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDoc, collection, doc, getDocFromServer, getDocs, limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';
import ScanAssignmentWorker from '../../components/ScanAssignmentWorker.jsx';
import { db } from '../../firebase/firebase.js';
import { markPickedLocationEmpty } from '../../utils/inventorySync.js';

const SYSTEM_SETTINGS_REF = doc(db, 'settings', 'system');
const AUTOMATION_STATUS_REF = doc(db, 'automation', 'status');
const ESP_DEVICE_REF = doc(db, 'devices', 'esp-main-01');
const ESP_DEVICE_ID = 'esp-main-01';
const TOTAL_MOVEMENT_POSITIONS = 18;
const ONLINE_WINDOW_MS = 30000;
const BULK_PICK_DELIVERY_DELAY_MS = 5000;
const BULK_PICK_COMMAND_TIMEOUT_MS = 180000;
const VALID_SORTING_STRATEGIES = new Set([
  'brand',
  'size',
  'color',
  'model',
  'brand_size',
  'color_size',
  'model_size',
  'sku_exact',
  'smart_auto',
  'nearest_location_priority',
]);

const SORTING_OPTIONS = [
  { value: '', label: 'Select strategy', description: 'Choose how new scanned products are assigned to empty locations.' },
  { value: 'brand', label: 'Brand', description: 'Cluster matching brands together.' },
  { value: 'size', label: 'Size Ordered', description: 'Keep smaller sizes before larger sizes and cluster equal sizes.' },
  { value: 'color', label: 'Color', description: 'Cluster matching colors together.' },
  { value: 'model', label: 'Model', description: 'Cluster matching models together with brand fallback.' },
  { value: 'brand_size', label: 'Brand + Size', description: 'Prefer the same brand area, then keep sizes ordered inside it.' },
  { value: 'color_size', label: 'Color + Size', description: 'Prefer the same color area, then keep sizes ordered inside it.' },
  { value: 'model_size', label: 'Model + Size', description: 'Prefer the same model area, then keep sizes ordered inside it.' },
  { value: 'sku_exact', label: 'Exact SKU Cluster', description: 'Place exact matching SKUs beside each other, with model-size fallback.' },
  { value: 'smart_auto', label: 'Smart Auto', description: 'Automatically choose SKU, model, brand, color, or size ordering from existing stock.' },
  { value: 'nearest_location_priority', label: 'Nearest Location Priority', description: 'Ignore product attributes and pick the first empty location in fixed priority order: 1, 2, 4, 3, 5, 7, 6, 8, 9.' },
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
  lastError: '',
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

function wait(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function isStoredLocation(location) {
  const id = locationIdOf(location);
  return (
    Number.isInteger(id) &&
    id >= 1 &&
    id <= 9 &&
    String(location?.status || '').toLowerCase() === 'full' &&
    (location?.occupied === true || location?.isOccupied === true)
  );
}

function productTitleFromLocation(location) {
  return [location?.brand, location?.model, location?.color, location?.size]
    .filter(Boolean)
    .join(' ') || location?.productKey || location?.sku || 'Stored product';
}

function isCompletedCommandStatus(status) {
  return ['done', 'completed', 'complete', 'executed'].includes(String(status || '').toLowerCase());
}

function isFailedCommandStatus(status) {
  return ['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

async function logBulkPickActivity(activityType, message, details = {}, status = 'info') {
  const data = {
    type: activityType,
    activityType,
    message,
    details,
    source: 'website-bulk-retrieval',
    sourceDevice: 'website',
    status,
    createdAt: serverTimestamp(),
  };

  return Promise.allSettled([
    addDoc(collection(db, 'systemActivity'), data),
    addDoc(collection(db, 'activityLog'), data),
    addDoc(collection(db, 'automationLogs'), data),
  ]);
}

async function createAutomationCommand(command) {
  const commandRef = doc(collection(db, 'commands'));
  const commandId = commandRef.id;

  try {
    await setDoc(commandRef, {
      commandId,
      command,
      arduinoCommand: command,
      type: 'AUTOMATION',
      status: 'pending',
      source: 'website-admin-control',
      deviceId: ESP_DEVICE_ID,
      payload: {
        requestedBy: 'admin-control-panel',
      },
      response: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const createdCommand = await getDocFromServer(commandRef);
    if (!createdCommand.exists()) {
      throw new Error(`${command} command was not created in Firestore.`);
    }

    console.info('[COMMAND_CREATED]', {
      commandId,
      command,
      status: 'pending',
      deviceId: ESP_DEVICE_ID,
      collectionPath: 'commands',
    });
  } catch (error) {
    console.error('[COMMAND_CREATION_FAILED]', {
      commandId,
      command,
      status: 'pending',
      deviceId: ESP_DEVICE_ID,
      collectionPath: 'commands',
      error,
    });
    throw error;
  }

  return commandId;
}

async function createBulkRetrievalCommand({ command, arduinoCommand, payload, type = 'PICK_BY_SIZE' }) {
  const commandRef = doc(collection(db, 'commands'));
  const commandId = commandRef.id;
  const cleanPayload = Object.fromEntries(
    Object.entries(payload || {}).map(([key, value]) => [key, value ?? null]),
  );

  await setDoc(commandRef, {
    commandId,
    command,
    arduinoCommand,
    type,
    status: 'pending',
    source: 'website-bulk-retrieval',
    deviceId: ESP_DEVICE_ID,
    payload: cleanPayload,
    response: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  console.info('[PICK_BY_SIZE_COMMAND_CREATED]', {
    commandId,
    command,
    arduinoCommand,
    deviceId: ESP_DEVICE_ID,
    payload: cleanPayload,
  });

  return { commandId, commandRef };
}

async function waitForCommandDone(commandRef, timeoutMs = BULK_PICK_COMMAND_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await getDocFromServer(commandRef);
    if (!snapshot.exists()) {
      throw new Error('Command document disappeared before completion.');
    }

    const command = snapshot.data();
    if (isCompletedCommandStatus(command.status)) return command;
    if (isFailedCommandStatus(command.status)) {
      throw new Error(command.response || command.error || `Command failed with status ${command.status}.`);
    }

    await wait(1000);
  }

  throw new Error('Timed out waiting for Arduino command completion.');
}

async function acquireBulkPickLock(operationId, requestedSize) {
  await runTransaction(db, async (transaction) => {
    const statusSnapshot = await transaction.get(AUTOMATION_STATUS_REF);
    const status = statusSnapshot.exists() ? statusSnapshot.data() : {};

    if (status.bulkRetrievalRunning === true) {
      throw new Error('A bulk retrieval queue is already running.');
    }

    transaction.set(AUTOMATION_STATUS_REF, {
      bulkRetrievalRunning: true,
      bulkRetrievalOperationId: operationId,
      currentState: 'PICK_BY_SIZE_STARTING',
      currentOperation: `PICK_BY_SIZE ${requestedSize}`,
      lifterBusy: true,
      lastError: '',
      updatedAt: serverTimestamp(),
    }, { merge: true });
  });
}

async function verifyAutomationStatus(expected) {
  const snapshot = await getDocFromServer(AUTOMATION_STATUS_REF);
  if (!snapshot.exists()) {
    throw new Error('automation/status was not found after update.');
  }

  const actual = snapshot.data();
  const mismatchedField = Object.entries(expected).find(([key, value]) => actual[key] !== value);
  if (mismatchedField) {
    const [key, value] = mismatchedField;
    throw new Error(`automation/status ${key} is ${String(actual[key])}, expected ${String(value)}.`);
  }

  return actual;
}

async function verifySortingStrategySaved(strategy) {
  const snapshot = await getDocFromServer(SYSTEM_SETTINGS_REF);
  if (!snapshot.exists() || snapshot.data().sortingMode !== strategy) {
    throw new Error('Sorting strategy was not saved before automation start.');
  }
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

function formatLogDetails(details) {
  if (!details || Object.keys(details).length === 0) return '';
  return JSON.stringify(details);
}

function AdminControlPanel() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [sortingMode, setSortingMode] = useState(DEFAULT_SETTINGS.sortingMode);
  const [locations, setLocations] = useState([]);
  const [latestScan, setLatestScan] = useState(null);
  const [pickQueue, setPickQueue] = useState([]);
  const [scanQueue, setScanQueue] = useState([]);
  const [orderQueue, setOrderQueue] = useState([]);
  const [commands, setCommands] = useState([]);
  const [automationLogs, setAutomationLogs] = useState([]);
  const [automationStatus, setAutomationStatus] = useState(DEFAULT_AUTOMATION_STATUS);
  const [espDevice, setEspDevice] = useState(null);
  const [products, setProducts] = useState([]);
  const [quickRetrieve, setQuickRetrieve] = useState({ brand: '', model: '', color: '', size: '' });
  const [bulkPickSize, setBulkPickSize] = useState('');
  const [bulkPickState, setBulkPickState] = useState({
    running: false,
    paused: false,
    total: 0,
    completed: 0,
    failed: 0,
    currentIndex: 0,
    currentLocation: '',
    currentProduct: '',
  });
  const [productSearch, setProductSearch] = useState('');
  const [advancedBoxId, setAdvancedBoxId] = useState('');
  const [firebaseOnline, setFirebaseOnline] = useState(false);
  const [saving, setSaving] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const commandRequestInFlight = useRef(false);
  const bulkPickRunningRef = useRef(false);
  const bulkPickStopRequestedRef = useRef(false);
  const sortingModeRef = useRef(DEFAULT_SETTINGS.sortingMode);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      SYSTEM_SETTINGS_REF,
      (snapshot) => {
        const nextSettings = {
          ...DEFAULT_SETTINGS,
          ...(snapshot.exists() ? snapshot.data() : {}),
        };
        setSettings(nextSettings);
        const nextSortingMode = nextSettings.sortingMode || DEFAULT_SETTINGS.sortingMode;
        setSortingMode(nextSortingMode);
        sortingModeRef.current = nextSortingMode;
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

    const commandsQuery = query(collection(db, 'commands'), orderBy('createdAt', 'desc'), limit(50));
    const unsubscribeCommands = onSnapshot(
      commandsQuery,
      (snapshot) => setCommands(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setCommands([]),
    );

    const automationLogsQuery = query(collection(db, 'automationLogs'), orderBy('createdAt', 'desc'), limit(60));
    const unsubscribeAutomationLogs = onSnapshot(
      automationLogsQuery,
      (snapshot) => setAutomationLogs(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setAutomationLogs([]),
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
      unsubscribePickQueue();
      unsubscribeScanQueue();
      unsubscribeOrderQueue();
      unsubscribeCommands();
      unsubscribeAutomationLogs();
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
      pick: queueCounts(pickQueue),
      scans: {
        confirmed: scanQueue.filter((item) => item.status === 'CONFIRMED').length,
        assigned: scanQueue.filter((item) => ['ASSIGNED', 'COMMAND_CREATED', 'PROCESSING'].includes(item.status) || item.assignmentStatus === 'COMMAND_CREATED').length,
        done: scanQueue.filter((item) => ['STORED', 'DONE'].includes(item.status)).length,
        error: scanQueue.filter((item) => item.status === 'ERROR').length,
      },
    };
  }, [pickQueue, scanQueue]);

  const currentOperation = useMemo(() => {
    const runningPick = pickQueue.find((item) => item.status === 'running');
    if (!runningPick) return null;
    return {
      type: 'GET',
      locationId: runningPick.locationId,
      movement: runningPick.outPosition ? `GO ${runningPick.outPosition}` : runningPick.inPosition ? `GO ${runningPick.inPosition}` : runningPick.goPosition ? `GO ${runningPick.goPosition}` : '--',
    };
  }, [pickQueue]);

  const commandsByScanId = useMemo(() => {
    const map = new Map();
    commands.forEach((command) => {
      if (command.command !== 'GO') return;
      if (command.scanId) map.set(command.scanId, command);
      if (command.payload?.scanId) map.set(command.payload.scanId, command);
    });
    return map;
  }, [commands]);

  const scanAssignmentItems = useMemo(() => {
    return scanQueue
      .filter((item) => ['CONFIRMED', 'ASSIGNED', 'COMMAND_CREATED', 'PROCESSING', 'STORED', 'DONE', 'ERROR'].includes(String(item.status || '').toUpperCase()))
      .slice(0, 12)
      .map((item) => ({
        ...item,
        command: commandsByScanId.get(item.scanId || item.id),
      }));
  }, [commandsByScanId, scanQueue]);

  const latestConfirmedScan = useMemo(() => {
    return scanQueue.find((item) => item.status === 'CONFIRMED') || (latestScan?.status === 'CONFIRMED' ? latestScan : null);
  }, [latestScan, scanQueue]);

  const automationDebugSummary = useMemo(() => {
    const findLatestLog = (type) => automationLogs.find((item) => item.type === type);
    const processingLog = findLatestLog('SCAN_PROCESSING_STARTED');
    const selectedLog = findLatestLog('LOCATION_SELECTED');
    const commandLog = findLatestLog('COMMAND_CREATED') || findLatestLog('COMMAND_ALREADY_EXISTS');
    const beltCommandLog = findLatestLog('BELT_MOVE_COMMAND_CREATED') || findLatestLog('BELT_COMMAND_ALREADY_EXISTS');
    const emptyLocationsLog = findLatestLog('EMPTY_LOCATIONS_FOUND');
    const errorLog = findLatestLog('PROCESS_ERROR');

    return {
      currentProcessingScan: processingLog?.scanId || '--',
      selectedLocation: selectedLog?.selectedLocation || '--',
      createdCommandId: commandLog?.commandId || '--',
      beltCommandId: beltCommandLog?.commandId || '--',
      emptyLocationsCount: Array.isArray(emptyLocationsLog?.details?.emptyLocations)
        ? emptyLocationsLog.details.emptyLocations.length
        : '--',
      currentError: errorLog?.message || '--',
    };
  }, [automationLogs]);

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
    if (!enabled && bulkPickRunningRef.current) {
      bulkPickStopRequestedRef.current = true;
    }

    if (commandRequestInFlight.current) return;

    const actionLabel = enabled ? 'Start Automation' : 'Stop Automation';
    const command = enabled ? 'START_AUTOMATION' : 'STOP_AUTOMATION';
    const strategy = sortingModeRef.current.trim();

    if (enabled && !VALID_SORTING_STRATEGIES.has(strategy)) {
      setError('Choose a sorting strategy before starting automation.');
      return;
    }

    console.info(enabled ? '[START_AUTOMATION_CLICKED]' : '[STOP_AUTOMATION_CLICKED]', {
      command,
      status: 'pending',
      deviceId: ESP_DEVICE_ID,
      collectionPath: 'commands',
    });
    commandRequestInFlight.current = true;
    setSaving(actionLabel);
    setError('');
    setNotice('');

    try {
      const nextStatus = enabled ? {
        automationStarted: true,
        sortingStrategy: strategy,
        currentState: 'WAIT_BOX_AT_CAMERA',
        lastError: '',
        beltBlocked: false,
        cameraBusy: false,
        lifterBusy: false,
      } : {
        automationStarted: false,
        sortingStrategy: strategy,
        currentState: 'STOPPED',
        lastError: 'Stopped by operator',
        beltBlocked: true,
        cameraBusy: false,
        lifterBusy: false,
      };

      await Promise.all([
        setDoc(SYSTEM_SETTINGS_REF, {
          automationEnabled: enabled,
          sortingMode: strategy,
          lastControlAction: command,
          controlRequestedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: true }),
        setDoc(AUTOMATION_STATUS_REF, {
          ...nextStatus,
          beltRunning: false,
          currentOperation: '',
          updatedAt: serverTimestamp(),
        }, { merge: true }),
      ]);
      console.log('AUTOMATION_STATUS_UPDATED');

      if (enabled) {
        await verifySortingStrategySaved(strategy);
        console.log('SORTING_STRATEGY_SAVED');
      }

      await verifyAutomationStatus(nextStatus);

      const commandId = await createAutomationCommand(command);
      console.info(`${command} sent`);

      await logWebsiteActivity(
        enabled ? 'AUTOMATION_STARTED' : 'AUTOMATION_STOPPED',
        enabled ? `Automation started with ${strategy}.` : 'Automation stopped by operator.',
      );

      setNotice(`${actionLabel} command sent. Command ID: ${commandId}`);
    } catch (requestError) {
      setError(requestError.message || `Unable to ${enabled ? 'start' : 'stop'} automation.`);
    } finally {
      commandRequestInFlight.current = false;
      setSaving('');
    }
  };

  const handleSortingSave = async () => {
    const strategy = sortingModeRef.current.trim();
    if (!VALID_SORTING_STRATEGIES.has(strategy)) {
      setError('Choose a sorting strategy first.');
      return;
    }
    setSaving('Sorting Strategy');
    setError('');
    setNotice('');
    try {
      await Promise.all([
        setDoc(SYSTEM_SETTINGS_REF, {
          sortingMode: strategy,
          updatedAt: serverTimestamp(),
        }, { merge: true }),
        setDoc(AUTOMATION_STATUS_REF, {
          sortingStrategy: strategy,
          currentState: automationStatus.automationStarted ? 'WAIT_BOX_AT_CAMERA' : 'WAIT_FOR_AUTOMATION',
          lastError: '',
          updatedAt: serverTimestamp(),
        }, { merge: true }),
      ]);
      await verifySortingStrategySaved(strategy);
      console.log('SORTING_STRATEGY_SAVED');
      setNotice('Sorting Strategy saved.');
    } catch {
      setError('Unable to save Sorting Strategy.');
    } finally {
      setSaving('');
    }
  };

  const handleSortingModeChange = (event) => {
    const nextSortingMode = event.target.value;
    sortingModeRef.current = nextSortingMode;
    setSortingMode(nextSortingMode);
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
        lastError: '',
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setNotice('Automation error cleared.');
    } catch {
      setError('Unable to clear automation error.');
    } finally {
      setSaving('');
    }
  };

  const pickAllBySize = async (size) => {
    const requestedSize = normalize(size);
    if (!requestedSize) {
      throw new Error('Enter a shoe size.');
    }
    if (bulkPickRunningRef.current) {
      throw new Error('A bulk retrieval queue is already running.');
    }

    bulkPickRunningRef.current = true;
    bulkPickStopRequestedRef.current = false;
    const operationId = `PICK_BY_SIZE_${requestedSize}_${Date.now()}`;
    let completed = 0;
    let failed = 0;
    let paused = false;
    let lockAcquired = false;

    try {
      await acquireBulkPickLock(operationId, requestedSize);
      lockAcquired = true;

      const [locationSnapshot, productSnapshot] = await Promise.all([
        getDocs(collection(db, 'locations')),
        getDocs(collection(db, 'products')),
      ]);

      const freshProducts = productSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      const productsByKey = new Map();
      freshProducts.forEach((product) => {
        [product.id, product.productId, product.sku, product.normalizedSku]
          .filter(Boolean)
          .forEach((key) => productsByKey.set(normalize(key), product));
      });

      const queue = locationSnapshot.docs
        .map((item) => {
          const location = { id: item.id, ...item.data() };
          const product = [location.productId, location.sku, location.normalizedSku]
            .map((key) => productsByKey.get(normalize(key)))
            .find(Boolean);
          return {
            ...location,
            productSize: normalize(location.size || product?.size),
            productTitle: productTitleFromLocation({ ...product, ...location }),
          };
        })
        .filter((location) => isStoredLocation(location) && location.productSize === requestedSize)
        .sort((left, right) => locationIdOf(left) - locationIdOf(right));

      setBulkPickState({
        running: true,
        paused: false,
        total: queue.length,
        completed: 0,
        failed: 0,
        currentIndex: 0,
        currentLocation: '',
        currentProduct: '',
      });
      setNotice(queue.length === 0 ? `No stored products found for size ${requestedSize}.` : `Found ${queue.length} product${queue.length === 1 ? '' : 's'} for size ${requestedSize}.`);

      console.info('[PICK_BY_SIZE_STARTED]', { operationId, requestedSize, total: queue.length });
      await logBulkPickActivity(
        'PICK_BY_SIZE_STARTED',
        `Pick by size started for size ${requestedSize}.`,
        { operationId, requestedSize, total: queue.length },
      );

      await setDoc(AUTOMATION_STATUS_REF, {
        currentState: queue.length > 0 ? 'PICK_BY_SIZE_RUNNING' : 'IDLE',
        currentOperation: queue.length > 0 ? `PICK_BY_SIZE ${requestedSize}` : '',
        lifterBusy: queue.length > 0,
        bulkRetrievalRunning: queue.length > 0,
        bulkRetrievalOperationId: queue.length > 0 ? operationId : null,
        lastError: '',
        updatedAt: serverTimestamp(),
      }, { merge: true });

      for (let index = 0; index < queue.length; index += 1) {
        const location = queue[index];
        const locationNumber = locationIdOf(location);
        const locationDocumentId = location.id || String(locationNumber);
        const productTitle = location.productTitle;

        setBulkPickState((current) => ({
          ...current,
          currentIndex: index + 1,
          currentLocation: String(locationNumber),
          currentProduct: productTitle,
        }));

        console.info('[PICK_BY_SIZE_ITEM_STARTED]', { operationId, requestedSize, locationNumber, productTitle });
        await logBulkPickActivity(
          'PICK_BY_SIZE_ITEM_STARTED',
          `Retrieving ${productTitle} from location ${locationNumber}.`,
          {
            operationId,
            requestedSize,
            locationId: locationDocumentId,
            locationNumber,
            productId: location.productId || null,
            sku: location.sku || null,
          },
        );

        try {
          const arduinoCommand = `PICK_LOCATION ${locationNumber}`;
          const { commandId, commandRef } = await createBulkRetrievalCommand({
            command: 'PICK_LOCATION',
            arduinoCommand,
            payload: {
              operation: 'PICK_BY_SIZE',
              operationId,
              size: requestedSize,
              locationId: locationDocumentId,
              locationNumber,
              productId: location.productId || null,
              sku: location.sku || null,
              normalizedSku: location.normalizedSku || null,
            },
          });

          await waitForCommandDone(commandRef);
          await wait(BULK_PICK_DELIVERY_DELAY_MS);
          await markPickedLocationEmpty(locationDocumentId, {
            operation: 'PICK_BY_SIZE',
            operationId,
            commandId,
            size: requestedSize,
            locationNumber,
          });
          await addDoc(collection(db, 'movementLogs'), {
            type: 'PICK_BY_SIZE_ITEM_COMPLETED',
            operation: 'PICK_BY_SIZE',
            operationId,
            commandId,
            locationId: locationDocumentId,
            locationNumber,
            productId: location.productId || null,
            sku: location.sku || null,
            size: requestedSize,
            productTitle,
            status: 'completed',
            createdAt: serverTimestamp(),
          });

          completed += 1;
          setBulkPickState((current) => ({
            ...current,
            completed,
            failed,
          }));
          console.info('[PICK_BY_SIZE_ITEM_COMPLETED]', { operationId, requestedSize, locationNumber, commandId });
          await logBulkPickActivity(
            'PICK_BY_SIZE_ITEM_COMPLETED',
            `Retrieved ${productTitle} from location ${locationNumber}.`,
            { operationId, requestedSize, locationNumber, commandId, completed, failed },
          );
        } catch (itemError) {
          failed += 1;
          setBulkPickState((current) => ({
            ...current,
            completed,
            failed,
          }));
          console.error('[PICK_BY_SIZE_ITEM_FAILED]', { operationId, requestedSize, locationNumber, error: itemError });
          await logBulkPickActivity(
            'PICK_BY_SIZE_ITEM_FAILED',
            `Failed to retrieve ${productTitle} from location ${locationNumber}.`,
            {
              operationId,
              requestedSize,
              locationId: locationDocumentId,
              locationNumber,
              error: itemError.message || String(itemError),
              completed,
              failed,
            },
            'error',
          );
        }

        if (bulkPickStopRequestedRef.current) {
          paused = true;
          break;
        }
      }

      if (paused) {
        await setDoc(AUTOMATION_STATUS_REF, {
          currentState: 'PAUSED',
          currentOperation: `PICK_BY_SIZE ${requestedSize}`,
          lifterBusy: false,
          bulkRetrievalRunning: false,
          bulkRetrievalOperationId: null,
          lastError: 'Bulk retrieval paused by STOP_AUTOMATION after current item.',
          updatedAt: serverTimestamp(),
        }, { merge: true });
        setBulkPickState((current) => ({
          ...current,
          running: false,
          paused: true,
          currentLocation: '',
          currentProduct: '',
        }));
        return { operationId, requestedSize, total: queue.length, completed, failed, paused };
      }

      if (queue.length > 0) {
        const { commandRef } = await createBulkRetrievalCommand({
          command: 'START',
          arduinoCommand: 'START',
          type: 'PICK_BY_SIZE_RETURN_HOME',
          payload: {
            operation: 'PICK_BY_SIZE',
            operationId,
            size: requestedSize,
          },
        });
        await waitForCommandDone(commandRef, 140000);
      }

      await setDoc(AUTOMATION_STATUS_REF, {
        currentState: 'IDLE',
        currentOperation: '',
        lifterBusy: false,
        bulkRetrievalRunning: false,
        bulkRetrievalOperationId: null,
        updatedAt: serverTimestamp(),
      }, { merge: true });

      console.info('[PICK_BY_SIZE_COMPLETED]', { operationId, requestedSize, total: queue.length, completed, failed });
      await logBulkPickActivity(
        'PICK_BY_SIZE_COMPLETED',
        `Pick by size completed for size ${requestedSize}.`,
        { operationId, requestedSize, total: queue.length, completed, failed },
      );

      setBulkPickState((current) => ({
        ...current,
        running: false,
        paused: false,
        total: queue.length,
        completed,
        failed,
        currentLocation: '',
        currentProduct: '',
      }));

      return { operationId, requestedSize, total: queue.length, completed, failed, paused: false };
    } finally {
      bulkPickRunningRef.current = false;
      if (lockAcquired) {
        await setDoc(AUTOMATION_STATUS_REF, {
          bulkRetrievalRunning: false,
          bulkRetrievalOperationId: null,
          lifterBusy: false,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
    }
  };

  const handlePickBySize = async (event) => {
    event.preventDefault();
    setSaving('Pick By Size');
    setError('');
    setNotice('');

    try {
      const summary = await pickAllBySize(bulkPickSize);
      if (summary.paused) {
        setNotice(`Pick by size paused after ${summary.completed} of ${summary.total}. Failed: ${summary.failed}.`);
      } else {
        setNotice(`Pick by size complete. Retrieved ${summary.completed} of ${summary.total}. Failed: ${summary.failed}.`);
      }
    } catch (pickError) {
      setError(pickError.message || 'Unable to run Pick By Size.');
      setBulkPickState((current) => ({
        ...current,
        running: false,
        currentLocation: '',
        currentProduct: '',
      }));
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

  const bulkPickProgressLabel = bulkPickState.running
    ? `Retrieving ${bulkPickState.currentIndex || 0} / ${bulkPickState.total}`
    : `${bulkPickState.completed} / ${bulkPickState.total} Retrieved`;

  return (
    <div className="admin-control-page">
      <ScanAssignmentWorker />
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
            <p className="section-eyebrow">Automation debug</p>
            <h2>Automation Debug Log</h2>
          </div>
        </div>

        <div className="control-detail-grid">
          <div>
            <span>Latest Confirmed Scan</span>
            <strong>{latestConfirmedScan?.productKey || [latestConfirmedScan?.brand, latestConfirmedScan?.model, latestConfirmedScan?.color, latestConfirmedScan?.size].filter(Boolean).join('|') || '--'}</strong>
          </div>
          <div>
            <span>Current Processing Scan</span>
            <strong>{automationDebugSummary.currentProcessingScan}</strong>
          </div>
          <div>
            <span>Selected Sorting Mode</span>
            <strong>{sortingMode || selectedStrategy || '--'}</strong>
          </div>
          <div>
            <span>Empty Locations Count</span>
            <strong>{automationDebugSummary.emptyLocationsCount}</strong>
          </div>
          <div>
            <span>Selected Location</span>
            <strong>{automationDebugSummary.selectedLocation}</strong>
          </div>
          <div>
            <span>Created Command ID</span>
            <strong>{automationDebugSummary.createdCommandId}</strong>
          </div>
          <div>
            <span>Belt Command ID</span>
            <strong>{automationDebugSummary.beltCommandId}</strong>
          </div>
          <div>
            <span>Current Error</span>
            <strong>{automationDebugSummary.currentError}</strong>
          </div>
        </div>

        <div className="queue-list">
          {automationLogs.length === 0 ? (
            <p className="orders-customer-meta">No automation debug logs yet.</p>
          ) : automationLogs.slice(0, 20).map((log) => (
            <div className="queue-row" key={log.id}>
              <strong>{formatDate(log.createdAt)} / {log.type}</strong>
              <span>
                {log.message || '-'}
                {log.scanId ? ` / scanId ${log.scanId}` : ''}
                {log.productKey ? ` / ${log.productKey}` : ''}
                {log.sortingMode ? ` / sorting ${log.sortingMode}` : ''}
                {log.selectedLocation ? ` / location ${log.selectedLocation}` : ''}
                {log.commandId ? ` / command ${log.commandId}` : ''}
              </span>
              {formatLogDetails(log.details) && <span>{formatLogDetails(log.details)}</span>}
            </div>
          ))}
        </div>
      </section>

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
              disabled={Boolean(saving) && saving !== 'Pick By Size'}
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
            <select id="sorting-mode" value={sortingMode} onChange={handleSortingModeChange}>
              {SORTING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <small>{SORTING_OPTIONS.find((option) => option.value === sortingMode)?.description || SORTING_OPTIONS[0].description}</small>
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
            <p className="section-eyebrow">Bulk Retrieval</p>
            <h2>Pick By Size</h2>
            <p>Retrieve every stored product with the selected shoe size, one location at a time.</p>
          </div>
        </div>

        <form className="quick-retrieve-grid" onSubmit={handlePickBySize}>
          <label className="control-field" htmlFor="bulk-pick-size">
            <span>Size</span>
            <input
              id="bulk-pick-size"
              value={bulkPickSize}
              onChange={(event) => setBulkPickSize(event.target.value)}
              placeholder="40"
              type="text"
              disabled={bulkPickState.running}
            />
          </label>
          <button className="button button-primary" type="submit" disabled={Boolean(saving) || bulkPickState.running}>
            {bulkPickState.running ? 'Retrieving...' : 'Retrieve All'}
          </button>
        </form>

        <div className="control-detail-grid">
          <div>
            <span>Total Found Items</span>
            <strong>{bulkPickState.total}</strong>
          </div>
          <div>
            <span>Current Progress</span>
            <strong>{bulkPickProgressLabel}</strong>
          </div>
          <div>
            <span>Current Location</span>
            <strong>{bulkPickState.currentLocation || '--'}</strong>
          </div>
          <div>
            <span>Current Product</span>
            <strong>{bulkPickState.currentProduct || '--'}</strong>
          </div>
          <div>
            <span>Failed Items</span>
            <strong>{bulkPickState.failed}</strong>
          </div>
          <div>
            <span>Queue Status</span>
            <strong>{bulkPickState.running ? 'Running' : bulkPickState.paused ? 'Paused' : 'Idle'}</strong>
          </div>
        </div>
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
            <h2>Scan Assignment Monitor</h2>
          </div>
          <div className="control-detail-grid">
            <div>
              <span>Confirmed</span>
              <strong>{queueSummary.scans.confirmed}</strong>
            </div>
            <div>
              <span>Assigned</span>
              <strong>{queueSummary.scans.assigned}</strong>
            </div>
            <div>
              <span>Stored / Done</span>
              <strong>{queueSummary.scans.done}</strong>
            </div>
            <div>
              <span>Errors</span>
              <strong>{queueSummary.scans.error}</strong>
            </div>
            <div>
              <span>Pick Waiting</span>
              <strong>{queueSummary.pick.waiting}</strong>
            </div>
            <div>
              <span>Pick Running</span>
              <strong>{queueSummary.pick.running}</strong>
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
            <h2>Scan Assignments</h2>
          </div>
          <div className="queue-list">
            {scanAssignmentItems.length === 0 ? (
              <p className="orders-customer-meta">No confirmed scans waiting for assignment.</p>
            ) : scanAssignmentItems.map((item) => (
              <div className="queue-row" key={item.id}>
                <strong>{item.productKey || [item.brand, item.model, item.color, item.size].filter(Boolean).join('|')}</strong>
                <span>
                  {item.status || 'WAITING'}
                  {item.assignmentStatus ? ` / ${item.assignmentStatus}` : ''}
                  {' / '}Location {item.selectedLocation || item.locationId || '-'}
                  {' / '}Command {item.command?.status || item.commandId || '-'}
                </span>
                {item.errorMessage && <span>{item.errorMessage}</span>}
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
