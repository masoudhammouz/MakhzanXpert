import { collection, getDocs, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

const REFRESH_INTERVAL_MS = 5000;
const ONLINE_WINDOW_MS = 30000;

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
  if (!date) return '-';

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function displayValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '-';
  return `${value}${suffix}`;
}

function displaySensorValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '--';
  return `${value}${suffix}`;
}

function getReadingTimestamp(reading) {
  return reading.createdAt || reading.timestamp || reading.time || reading.recordedAt;
}

function getDeviceLastSeen(device) {
  if (!device) return null;
  return device.lastSeen || device.updatedAt || device.timestamp || device.createdAt;
}

function getDeviceStatus(device) {
  if (!device) return 'Offline';

  const explicitStatus = String(device.status || '').toLowerCase();
  if (['online', 'offline'].includes(explicitStatus)) {
    return explicitStatus === 'online' ? 'Online' : 'Offline';
  }

  const lastSeenMs = getTimestampMs(getDeviceLastSeen(device));
  return lastSeenMs && Date.now() - lastSeenMs <= ONLINE_WINDOW_MS ? 'Online' : 'Offline';
}

function getActivityStatusClass(status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'success') return 'status-available';
  if (normalizedStatus === 'warning') return 'status-low-stock';
  if (normalizedStatus === 'error') return 'status-unavailable';
  return 'status-ready';
}

function AdminSensors() {
  const [readings, setReadings] = useState([]);
  const [devices, setDevices] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState(null);

  useEffect(() => {
    let mounted = true;

    const fetchSensorData = async () => {
      try {
        const readingsQuery = query(collection(db, 'sensorReadings'), orderBy('createdAt', 'desc'), limit(20));

        const [readingsSnapshot, devicesSnapshot] = await Promise.all([
          getDocs(readingsQuery),
          getDocs(collection(db, 'devices')),
        ]);

        if (!mounted) return;

        const nextReadings = readingsSnapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }));
        const nextDevices = devicesSnapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .sort((a, b) => getTimestampMs(getDeviceLastSeen(b)) - getTimestampMs(getDeviceLastSeen(a)));

        setReadings(nextReadings);
        setDevices(nextDevices);
        setLastRefresh(new Date());
        setError('');
      } catch {
        if (mounted) {
          setError('Unable to refresh live sensor data from Firestore.');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchSensorData();
    const intervalId = window.setInterval(fetchSensorData, REFRESH_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const activityQuery = query(collection(db, 'systemActivity'), orderBy('createdAt', 'desc'), limit(5));
    const unsubscribe = onSnapshot(
      activityQuery,
      (snapshot) => {
        setActivities(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      },
      () => {
        setActivities([]);
      },
    );

    return unsubscribe;
  }, []);

  const latest = readings[0];
  const primaryDevice = devices[0];
  const deviceStatus = getDeviceStatus(primaryDevice);

  const summary = useMemo(() => ({
    temperature: latest?.temperature,
    humidity: latest?.humidity,
    mq3: latest?.mq3,
    mq135: latest?.mq135,
    waterValue: latest?.waterValue,
    waterDetected: latest?.waterDetected,
    waterStatus: latest?.waterStatus,
    motion: latest?.motion,
    motionStatus: latest?.motionStatus,
  }), [latest]);

  const waterDetectionStatus = summary.waterDetected === true
    ? 'WATER DETECTED'
    : summary.waterDetected === false
      ? 'DRY'
      : 'No data';
  const waterSensorNote = summary.waterStatus
    ? `${waterDetectionStatus} / ${summary.waterStatus}`
    : waterDetectionStatus;
  const motionValue = summary.motion === 1
    ? 'Motion Detected'
    : summary.motion === 0
      ? 'No Motion'
      : 'No data';

  const statusCards = [
    {
      label: 'Temperature',
      value: displayValue(summary.temperature, summary.temperature !== undefined ? ' °C' : ''),
      note: 'Latest warehouse temperature',
    },
    {
      label: 'Humidity',
      value: displayValue(summary.humidity, summary.humidity !== undefined ? '%' : ''),
      note: 'Latest relative humidity',
    },
    {
      label: 'Air Quality (MQ135)',
      value: displayValue(summary.mq135),
      note: 'MQ135 air quality sensor',
    },
    {
      label: 'Gas Detection (MQ3)',
      value: displayValue(summary.mq3),
      note: 'MQ3 gas sensor',
    },
    {
      label: 'Water Sensor',
      value: displaySensorValue(summary.waterValue),
      note: waterSensorNote,
    },
    {
      label: 'Motion Sensor',
      value: motionValue,
      note: summary.motionStatus || 'No data',
    },
  ];

  return (
    <div className="admin-sensors-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Live sensors</p>
          <h1>Sensors Dashboard</h1>
          <p>Live Firestore monitoring for warehouse environment readings and connected device state.</p>
        </div>
        <div className="sensor-refresh-meta" aria-live="polite">
          <span className="status-badge status-ready">Refresh: 5s</span>
          <span>{lastRefresh ? `Updated ${formatDate(lastRefresh)}` : 'Waiting for first refresh'}</span>
        </div>
      </section>

      {error && <p className="admin-form-error">{error}</p>}

      <section className="inventory-summary-grid" aria-label="Latest sensor values">
        <article className="admin-summary-card">
          <p className="metric-label">Temperature °C</p>
          <p className="metric-value">{displayValue(summary.temperature, summary.temperature !== undefined ? ' °C' : '')}</p>
          <p className="metric-note">Latest sensorReadings document.</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Humidity %</p>
          <p className="metric-value">{displayValue(summary.humidity, summary.humidity !== undefined ? '%' : '')}</p>
          <p className="metric-note">Latest sensorReadings document.</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">MQ3</p>
          <p className="metric-value">{displayValue(summary.mq3)}</p>
          <p className="metric-note">Gas detection reading.</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">MQ135</p>
          <p className="metric-value">{displayValue(summary.mq135)}</p>
          <p className="metric-note">Air quality reading.</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Water Sensor</p>
          <p className="metric-value">{displaySensorValue(summary.waterValue)}</p>
          <p className="metric-note">{waterSensorNote}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Motion Sensor</p>
          <p className="metric-value">{motionValue}</p>
          <p className="metric-note">{summary.motionStatus || 'No data'}</p>
        </article>
      </section>

      <section className="inventory-summary-grid" aria-label="Sensor status cards">
        {statusCards.map((card) => (
          <article className="admin-summary-card sensor-status-card" key={card.label}>
            <p className="metric-label">{card.label}</p>
            <p className="metric-value">{card.value}</p>
            <p className="metric-note">{card.note}</p>
          </article>
        ))}
      </section>

      <section className="admin-inventory-panel">
        <div className="section-header">
          <div>
            <h2>Device Status</h2>
            <p>Current device information from the devices collection.</p>
          </div>
        </div>

        <div className="device-status-grid">
          <article className="device-status-card">
            <span className={deviceStatus === 'Online' ? 'status-badge status-available' : 'status-badge status-unavailable'}>
              {deviceStatus}
            </span>
            <div>
              <p className="metric-label">Device Name</p>
              <p className="device-status-value">{primaryDevice?.deviceName || primaryDevice?.name || primaryDevice?.id || '-'}</p>
            </div>
          </article>
          <article className="device-status-card">
            <p className="metric-label">Last Seen</p>
            <p className="device-status-value">{formatDate(getDeviceLastSeen(primaryDevice))}</p>
          </article>
          <article className="device-status-card">
            <p className="metric-label">Current Task</p>
            <p className="device-status-value">{primaryDevice?.currentTask || primaryDevice?.task || primaryDevice?.activeTask || 'Idle'}</p>
          </article>
        </div>
      </section>

      <section className="admin-inventory-panel">
        <div className="section-header">
          <div>
            <h2>Sensor History</h2>
            <p>Latest 20 readings from sensorReadings.</p>
          </div>
        </div>

        {loading ? (
          <LoadingState message="Loading live sensor data..." />
        ) : readings.length === 0 ? (
          <EmptyState title="No sensor readings yet" description="Waiting for devices to write sensorReadings." />
        ) : (
          <div className="inventory-table-wrap">
            <table className="inventory-table sensors-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Temperature</th>
                  <th>Humidity</th>
                  <th>MQ3</th>
                  <th>MQ135</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((reading) => (
                  <tr key={reading.id}>
                    <td>{formatDate(getReadingTimestamp(reading))}</td>
                    <td>{displayValue(reading.temperature, reading.temperature !== undefined ? ' °C' : '')}</td>
                    <td>{displayValue(reading.humidity, reading.humidity !== undefined ? '%' : '')}</td>
                    <td>{displayValue(reading.mq3)}</td>
                    <td>{displayValue(reading.mq135)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-inventory-panel">
        <div className="section-header">
          <div>
            <h2>System Activity</h2>
            <p>Latest 5 warehouse events from systemActivity.</p>
          </div>
        </div>
        {activities.length === 0 ? (
          <div className="system-activity-placeholder">
            Waiting for warehouse events...
          </div>
        ) : (
          <div className="sensor-activity-list">
            {activities.map((activity) => (
              <article className="sensor-activity-item" key={activity.id}>
                <span className={`status-badge ${getActivityStatusClass(activity.status)}`}>
                  {activity.status || 'info'}
                </span>
                <div>
                  <strong>{activity.message || '-'}</strong>
                  <p>{activity.sourceDevice || '-'} / {activity.activityType || '-'}</p>
                </div>
                <time>{formatDate(activity.createdAt)}</time>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default AdminSensors;
