import { collection, getDocs, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
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

function displaySensorValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '--';
  return `${value}${suffix}`;
}

function getReadingTimestamp(reading) {
  if (!reading) return null;
  return reading.createdAt || reading.timestamp || reading.time || reading.recordedAt;
}

function getDeviceLastSeen(device) {
  if (!device) return null;
  return device.lastSeen || device.updatedAt || device.timestamp || device.createdAt;
}

function getRelativeTime(value) {
  const timestamp = getTimestampMs(value);
  if (!timestamp) return 'No data';

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function getSensorConnectivity(latestReading) {
  const timestamp = getTimestampMs(getReadingTimestamp(latestReading));
  return timestamp && Date.now() - timestamp <= ONLINE_WINDOW_MS ? 'Online' : 'Offline';
}

function getTrend(current, previous, suffix = '') {
  if (typeof current !== 'number' || typeof previous !== 'number') {
    return { label: 'No trend', direction: 'flat' };
  }

  const delta = current - previous;
  if (Math.abs(delta) < 0.1) return { label: `Stable 0${suffix}`, direction: 'flat' };

  return {
    label: `${delta > 0 ? '+' : ''}${delta.toFixed(1)}${suffix}`,
    direction: delta > 0 ? 'up' : 'down',
  };
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
  const previous = readings[1];
  const sensorConnectivity = getSensorConnectivity(latest);
  const sensorOnline = sensorConnectivity === 'Online';
  const lastSensorUpdate = getReadingTimestamp(latest);

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
    ? 'Water Detected'
    : summary.waterDetected === false
      ? 'Dry'
      : 'No data';
  const motionValue = summary.motion === 1
    ? 'Motion Detected'
    : summary.motion === 0
      ? 'No Motion'
      : 'No data';

  const temperatureTrend = getTrend(summary.temperature, previous?.temperature, '°C');
  const humidityTrend = getTrend(summary.humidity, previous?.humidity, '%');
  const highTemperature = typeof summary.temperature === 'number' && summary.temperature >= 45;
  const gasWarning = Number(summary.mq3 || 0) >= 1500 || Number(summary.mq135 || 0) >= 1500;
  const gasAlert = Number(summary.mq3 || 0) >= 2500 || Number(summary.mq135 || 0) >= 2500;
  const fireAlert = gasAlert || (gasWarning && highTemperature);
  const fireWarning = !fireAlert && (gasWarning || highTemperature);
  const fireStatus = fireAlert ? 'Fire Alert' : fireWarning ? 'Warning' : latest ? 'Normal' : 'No data';
  const fireTone = fireAlert ? 'danger' : fireWarning ? 'warning' : latest ? 'success' : 'muted';
  const riskLevel = fireAlert ? 'High' : fireWarning ? 'Medium' : latest ? 'Low' : 'No data';
  const waterTone = summary.waterDetected === true ? 'danger' : summary.waterDetected === false ? 'success' : 'muted';
  const motionTone = summary.motion === 1 ? 'warning' : summary.motion === 0 ? 'success' : 'muted';

  return (
    <div className="admin-sensors-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Live sensors</p>
          <h1>Sensors Dashboard</h1>
          <p>Real-time warehouse environmental monitoring.</p>
        </div>
        <div className="sensor-refresh-meta" aria-live="polite">
          <span className={`sensor-pill ${sensorOnline ? 'online' : 'offline'}`}>{sensorConnectivity}</span>
          <span>{lastRefresh ? `Refreshed ${formatDate(lastRefresh)}` : 'Waiting for refresh'}</span>
        </div>
      </section>

      {error && <p className="admin-form-error">{error}</p>}

      <section className="warehouse-overview-bar" aria-label="Warehouse Status">
        <h2>Warehouse Status</h2>
        <div className="warehouse-overview-grid">
          <div className="overview-item">
            <span className={`overview-icon ${fireTone}`}>F</span>
            <div>
              <p>Fire Status</p>
              <strong className={fireTone}>{fireStatus}</strong>
            </div>
          </div>
          <div className="overview-item">
            <span className={`overview-icon ${waterTone}`}>W</span>
            <div>
              <p>Water Status</p>
              <strong className={waterTone}>{waterDetectionStatus}</strong>
            </div>
          </div>
          <div className="overview-item">
            <span className={`overview-icon ${motionTone}`}>M</span>
            <div>
              <p>Motion Status</p>
              <strong className={motionTone}>{motionValue}</strong>
            </div>
          </div>
          <div className="overview-item">
            <span className={`overview-icon ${sensorOnline ? 'success' : 'danger'}`}>S</span>
            <div>
              <p>Sensor Connectivity</p>
              <strong className={sensorOnline ? 'success' : 'danger'}>{sensorConnectivity}</strong>
            </div>
          </div>
          <div className="overview-item">
            <span className="overview-icon muted">T</span>
            <div>
              <p>Last Sensor Update</p>
              <strong>{getRelativeTime(lastSensorUpdate)}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="sensor-dashboard-grid top-row" aria-label="Primary warehouse sensor cards">
        <article className={`sensor-monitor-card fire ${fireTone}`}>
          <header className="sensor-card-header">
            <span className={`sensor-card-icon ${fireTone}`}>F</span>
            <div>
              <h2>Fire Monitoring System</h2>
              <span className={`sensor-pill ${sensorOnline ? 'online' : 'offline'}`}>{sensorConnectivity}</span>
            </div>
          </header>
          <div className="fire-status-block">
            <p>Fire Status</p>
            <strong className={fireTone}>{fireStatus}</strong>
          </div>
          <div className="fire-metrics-grid">
            <div>
              <span>MQ3 Value</span>
              <strong>{displaySensorValue(summary.mq3)}</strong>
            </div>
            <div>
              <span>MQ135 Value</span>
              <strong>{displaySensorValue(summary.mq135)}</strong>
            </div>
            <div>
              <span>Risk Level</span>
              <strong className={fireTone}>{riskLevel}</strong>
            </div>
          </div>
          <footer>Last Update: {getRelativeTime(lastSensorUpdate)}</footer>
        </article>

        <article className="sensor-monitor-card temperature">
          <header className="sensor-card-header">
            <span className="sensor-card-icon info thermometer-icon" aria-hidden="true"><span /></span>
            <div>
              <h2>Temperature</h2>
              <span className={`sensor-pill ${sensorOnline ? 'online' : 'offline'}`}>{sensorConnectivity}</span>
            </div>
          </header>
          <div className="large-reading">{displaySensorValue(summary.temperature, ' °C')}</div>
          <dl className="sensor-details-list">
            <div>
              <dt>Temperature Trend</dt>
              <dd className={temperatureTrend.direction}>{temperatureTrend.label}</dd>
            </div>
            <div>
              <dt>Last Update</dt>
              <dd>{getRelativeTime(lastSensorUpdate)}</dd>
            </div>
          </dl>
        </article>

        <article className="sensor-monitor-card humidity">
          <header className="sensor-card-header">
            <span className="sensor-card-icon purple humidity-icon" aria-hidden="true"><span /></span>
            <div>
              <h2>Humidity</h2>
              <span className={`sensor-pill ${sensorOnline ? 'online' : 'offline'}`}>{sensorConnectivity}</span>
            </div>
          </header>
          <div className="large-reading purple">{displaySensorValue(summary.humidity, '%')}</div>
          <dl className="sensor-details-list">
            <div>
              <dt>Humidity Trend</dt>
              <dd className={humidityTrend.direction}>{humidityTrend.label}</dd>
            </div>
            <div>
              <dt>Last Update</dt>
              <dd>{getRelativeTime(lastSensorUpdate)}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="sensor-dashboard-grid bottom-row" aria-label="Secondary warehouse sensor cards">
        <article className={`sensor-monitor-card water ${waterTone}`}>
          <header className="sensor-card-header">
            <span className={`sensor-card-icon ${waterTone}`}>W</span>
            <div>
              <h2>Water Monitoring</h2>
              <span className={`sensor-pill ${sensorOnline ? 'online' : 'offline'}`}>{sensorConnectivity}</span>
            </div>
          </header>
          <div className="binary-status">
            <span className={`status-orb ${waterTone}`}>W</span>
            <div>
              <strong className={waterTone}>{waterDetectionStatus}</strong>
              <p>{summary.waterStatus || (summary.waterDetected === true ? 'Water Detected' : summary.waterDetected === false ? 'Dry' : 'No data')}</p>
            </div>
          </div>
          <footer>Last Update: {getRelativeTime(lastSensorUpdate)}</footer>
        </article>

        <article className={`sensor-monitor-card motion ${motionTone}`}>
          <header className="sensor-card-header">
            <span className={`sensor-card-icon ${motionTone}`}>M</span>
            <div>
              <h2>Motion Detection</h2>
              <span className={`sensor-pill ${sensorOnline ? 'online' : 'offline'}`}>{sensorConnectivity}</span>
            </div>
          </header>
          <div className="binary-status">
            <span className={`status-orb ${motionTone}`}>M</span>
            <div>
              <strong className={motionTone}>{motionValue}</strong>
              <p>{summary.motionStatus || (summary.motion === 1 ? 'Motion Detected' : summary.motion === 0 ? 'No Motion' : 'No data')}</p>
            </div>
          </div>
          <footer>Last Update: {getRelativeTime(lastSensorUpdate)}</footer>
        </article>
      </section>

    </div>
  );
}

export default AdminSensors;
