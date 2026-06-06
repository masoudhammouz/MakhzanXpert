import { addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

function formatDate(value) {
  const timestamp = value?.toMillis ? value.toMillis() : 0;
  if (!timestamp) return '-';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function AdminSensors() {
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    const readingsQuery = query(collection(db, 'sensorReadings'), orderBy('createdAt', 'desc'), limit(25));
    const unsubscribe = onSnapshot(
      readingsQuery,
      (snapshot) => {
        setReadings(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        setLoading(false);
      },
      () => {
        setError('Unable to listen for sensor readings.');
        setLoading(false);
      },
    );

    return unsubscribe;
  }, []);

  const latest = readings[0];

  const summary = useMemo(() => ({
    temperature: latest?.temperature ?? '-',
    humidity: latest?.humidity ?? '-',
    mq3: latest?.mq3 ?? '-',
    mq135: latest?.mq135 ?? '-',
    gasStatus: latest?.gasStatus || 'No data',
    environmentStatus: latest?.environmentStatus || 'No data',
  }), [latest]);

  const handleSeedReading = async () => {
    setSeeding(true);
    setError('');

    try {
      await addDoc(collection(db, 'sensorReadings'), {
        deviceId: 'esp-main-001',
        deviceName: 'ESP Main Controller',
        temperature: Number((22 + Math.random() * 6).toFixed(1)),
        humidity: Number((45 + Math.random() * 20).toFixed(1)),
        mq3: Math.floor(120 + Math.random() * 80),
        mq135: Math.floor(180 + Math.random() * 120),
        gasStatus: Math.random() > 0.75 ? 'warning' : 'normal',
        environmentStatus: Math.random() > 0.75 ? 'humidity high' : 'stable',
        createdAt: serverTimestamp(),
      });
    } catch {
      setError('Unable to seed sensor reading.');
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="admin-sensors-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Live sensors</p>
          <h1>Sensors</h1>
          <p>Firebase-ready monitoring for ESP, Arduino, Raspberry Pi, camera, dispenser, conveyor, lift, and gas sensors.</p>
        </div>
        <button className="button button-primary" type="button" onClick={handleSeedReading} disabled={seeding}>
          {seeding ? 'Seeding...' : 'Seed Sensor Reading'}
        </button>
      </section>

      <section className="inventory-summary-grid" aria-label="Latest sensor summary">
        <article className="admin-summary-card">
          <p className="metric-label">Latest Temperature</p>
          <p className="metric-value">{summary.temperature}{summary.temperature !== '-' ? ' C' : ''}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Latest Humidity</p>
          <p className="metric-value">{summary.humidity}{summary.humidity !== '-' ? '%' : ''}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">MQ3</p>
          <p className="metric-value">{summary.mq3}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">MQ135</p>
          <p className="metric-value">{summary.mq135}</p>
        </article>
      </section>

      <section className="admin-inventory-panel">
        <div className="sensor-status-row">
          <span className="status-badge status-ready">Gas: {summary.gasStatus}</span>
          <span className="status-badge status-available">Environment: {summary.environmentStatus}</span>
        </div>

        {loading ? (
          <LoadingState message="Loading sensor readings..." />
        ) : readings.length === 0 ? (
          <EmptyState title="No sensor readings yet" description="Seed a test reading or wait for a device to write sensorReadings." />
        ) : (
          <>
            {error && <p className="admin-form-error">{error}</p>}
            <div className="inventory-table-wrap">
              <table className="inventory-table sensors-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Temperature</th>
                    <th>Humidity</th>
                    <th>MQ3</th>
                    <th>MQ135</th>
                    <th>Gas Status</th>
                    <th>Environment</th>
                    <th>Created At</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.map((reading) => (
                    <tr key={reading.id}>
                      <td className="inventory-product-name">{reading.deviceName || reading.deviceId || '-'}</td>
                      <td>{reading.temperature ?? '-'}</td>
                      <td>{reading.humidity ?? '-'}</td>
                      <td>{reading.mq3 ?? '-'}</td>
                      <td>{reading.mq135 ?? '-'}</td>
                      <td>{reading.gasStatus || '-'}</td>
                      <td>{reading.environmentStatus || '-'}</td>
                      <td>{formatDate(reading.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default AdminSensors;
