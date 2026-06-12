import { useEffect, useMemo, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../../firebase/firebase.js';

const SYSTEM_SETTINGS_REF = doc(db, 'settings', 'system');
const TOTAL_MOVEMENT_POSITIONS = 18;
const ONLINE_WINDOW_MS = 30000;

const SORTING_OPTIONS = [
  { value: 'brand', label: 'Brand' },
  { value: 'model', label: 'Model' },
  { value: 'size', label: 'Size' },
  { value: 'color', label: 'Color' },
  { value: 'brand_size', label: 'Brand + Size' },
  { value: 'model_size', label: 'Model + Size' },
  { value: 'color_size', label: 'Color + Size' },
  { value: 'custom', label: 'Custom' },
];

const DEFAULT_SETTINGS = {
  sortingMode: 'brand',
  automationEnabled: false,
  autoConveyor: true,
  autoOCR: true,
  autoPositionSelection: true,
  autoInventoryUpdate: true,
  requireIRVerification: false,
  firebaseLogging: true,
};

const AUTOMATION_OPTIONS = [
  { key: 'autoConveyor', label: 'Auto Conveyor' },
  { key: 'autoOCR', label: 'Auto OCR' },
  { key: 'autoPositionSelection', label: 'Auto Position Selection' },
  { key: 'autoInventoryUpdate', label: 'Auto Inventory Update' },
  { key: 'requireIRVerification', label: 'IR Placement Verification' },
  { key: 'firebaseLogging', label: 'Firebase Logging' },
];

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

function getDeviceTimestamp(device) {
  return device?.lastSeen || device?.updatedAt || device?.timestamp || device?.createdAt;
}

function getDeviceOnline(device) {
  const status = String(device?.status || '').toLowerCase();
  if (['online', 'connected', 'active'].includes(status)) return true;
  if (['offline', 'disconnected', 'inactive'].includes(status)) return false;
  return isRecent(getDeviceTimestamp(device));
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

function getMovementPositionStatus(position, locationsByPhysicalId) {
  const physicalLocation = Math.ceil(position / 2);
  const location = locationsByPhysicalId.get(physicalLocation);
  return location?.status === 'full' || location?.isOccupied ? 'occupied' : 'empty';
}

function StatusLine({ label, online }) {
  return (
    <div className="control-status-line">
      <span>{label}</span>
      <strong className={online ? 'online' : 'offline'}>
        <span className="control-status-dot" aria-hidden="true" />
        {online ? 'Online' : 'Offline'}
      </strong>
    </div>
  );
}

function AdminControlPanel() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [sortingMode, setSortingMode] = useState(DEFAULT_SETTINGS.sortingMode);
  const [locations, setLocations] = useState([]);
  const [devices, setDevices] = useState([]);
  const [latestScan, setLatestScan] = useState(null);
  const [latestActivity, setLatestActivity] = useState(null);
  const [firebaseOnline, setFirebaseOnline] = useState(false);
  const [saving, setSaving] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

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
    const unsubscribeLocations = onSnapshot(
      collection(db, 'locations'),
      (snapshot) => {
        setLocations(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      },
      () => setLocations([]),
    );

    const unsubscribeDevices = onSnapshot(
      collection(db, 'devices'),
      (snapshot) => {
        setDevices(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      },
      () => setDevices([]),
    );

    const scansQuery = query(collection(db, 'scans'), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribeScans = onSnapshot(
      scansQuery,
      (snapshot) => {
        setLatestScan(snapshot.docs[0] ? { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } : null);
      },
      () => setLatestScan(null),
    );

    const activityQuery = query(collection(db, 'systemActivity'), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribeActivity = onSnapshot(
      activityQuery,
      (snapshot) => {
        setLatestActivity(snapshot.docs[0] ? { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } : null);
      },
      () => setLatestActivity(null),
    );

    return () => {
      unsubscribeLocations();
      unsubscribeDevices();
      unsubscribeScans();
      unsubscribeActivity();
    };
  }, []);

  const deviceStatus = useMemo(() => {
    const esp32 = devices.find((device) => device.id === 'esp-main-01' || device.deviceId === 'esp-main-01') || devices[0];
    const latestScanOnline = isRecent(getScanTimestamp(latestScan));
    const latestActivityText = `${latestActivity?.type || ''} ${latestActivity?.message || ''} ${latestActivity?.status || ''}`.toLowerCase();

    return {
      esp32: getDeviceOnline(esp32),
      arduino: getDeviceOnline(esp32) && (latestActivityText.includes('arduino') || latestActivityText.includes('done') || latestActivityText.includes('sent')),
      raspberry: latestScanOnline || String(latestScan?.source || '').toLowerCase() === 'raspberry',
      firebase: firebaseOnline,
    };
  }, [devices, firebaseOnline, latestActivity, latestScan]);

  const locationsByPhysicalId = useMemo(() => {
    const map = new Map();
    locations.forEach((location) => {
      const id = Number(location.position || location.id);
      if (id >= 1 && id <= 9) map.set(id, location);
    });
    return map;
  }, [locations]);

  const warehouseSummary = useMemo(() => {
    const statuses = Array.from({ length: TOTAL_MOVEMENT_POSITIONS }, (_, index) => {
      const position = index + 1;
      return getMovementPositionStatus(position, locationsByPhysicalId);
    });

    return {
      total: TOTAL_MOVEMENT_POSITIONS,
      occupied: statuses.filter((status) => status === 'occupied').length,
      empty: statuses.filter((status) => status === 'empty').length,
    };
  }, [locationsByPhysicalId]);

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

  const handleAutomationToggle = (enabled) => {
    updateSettings({
      automationEnabled: enabled,
      lastControlAction: enabled ? 'START_AUTOMATION' : 'STOP_AUTOMATION',
      controlRequestedAt: serverTimestamp(),
    }, enabled ? 'Start Automation' : 'Stop Automation');
  };

  const handleSortingSave = () => {
    updateSettings({ sortingMode }, 'Sorting Strategy');
  };

  const handleOptionChange = (key, checked) => {
    setSettings((current) => ({ ...current, [key]: checked }));
    updateSettings({ [key]: checked }, key);
  };

  const handleEmergencyAction = (action) => {
    updateSettings({
      automationEnabled: action === 'EMERGENCY_STOP' ? false : settings.automationEnabled,
      emergencyStop: action === 'EMERGENCY_STOP',
      lastControlAction: action,
      controlRequestedAt: serverTimestamp(),
    }, action.replaceAll('_', ' '));
  };

  return (
    <div className="admin-control-page">
      <section className="admin-page-heading control-hero">
        <div>
          <p className="section-eyebrow">Automation console</p>
          <h1>Warehouse Automation Control Center</h1>
          <p>Manage automated scanning, sorting, lifter movement, and inventory synchronization.</p>
        </div>
        <span className={`control-mode-pill ${settings.automationEnabled ? 'enabled' : 'disabled'}`}>
          {settings.automationEnabled ? 'Automation Enabled' : 'Automation Disabled'}
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
              disabled={Boolean(saving) || settings.automationEnabled}
            >
              Start Automation
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => handleAutomationToggle(false)}
              disabled={Boolean(saving) || !settings.automationEnabled}
            >
              Stop Automation
            </button>
          </div>
        </div>

        <div className="control-system-grid">
          <div className="control-status-stack">
            <StatusLine label="ESP32" online={deviceStatus.esp32} />
            <StatusLine label="Arduino" online={deviceStatus.arduino} />
            <StatusLine label="Raspberry Pi" online={deviceStatus.raspberry} />
            <StatusLine label="Firebase" online={deviceStatus.firebase} />
          </div>
          <p className="control-description">
            When automation is enabled: Worker places cartons into dispenser. System automatically scans labels,
            chooses positions, moves lifter, updates inventory and waits for next carton.
          </p>
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
              <strong>{normalizeStatus(latestScan?.cameraStatus || (deviceStatus.raspberry ? 'online' : 'offline'))}</strong>
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
              <span>Selected Position</span>
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
            <h2>Warehouse Overview</h2>
            <p>Movement position occupancy mapped from physical warehouse locations.</p>
          </div>
          <div className="control-summary-row">
            <span>Total Positions <strong>{warehouseSummary.total}</strong></span>
            <span>Occupied Positions <strong>{warehouseSummary.occupied}</strong></span>
            <span>Empty Positions <strong>{warehouseSummary.empty}</strong></span>
          </div>
        </div>
        <div className="control-position-grid" aria-label="Warehouse movement positions">
          {Array.from({ length: TOTAL_MOVEMENT_POSITIONS }, (_, index) => {
            const position = index + 1;
            const status = getMovementPositionStatus(position, locationsByPhysicalId);

            return (
              <div className={`control-position-cell ${status}`} key={position}>
                <span>GO {position}</span>
                <strong>{status === 'occupied' ? 'Occupied' : 'Empty'}</strong>
              </div>
            );
          })}
        </div>
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
