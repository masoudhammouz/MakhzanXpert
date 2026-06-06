import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useAuth } from '../../context/AuthContext.jsx';
import { db } from '../../firebase/firebase.js';
import seedProducts, { resetProducts } from '../../utils/seedProducts.js';

function formatActivityDate(value) {
  const timestamp = value?.toMillis ? value.toMillis() : 0;
  if (!timestamp) return '-';

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function getActivityStatusClass(status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'success') return 'status-available';
  if (normalizedStatus === 'warning') return 'status-low-stock';
  if (normalizedStatus === 'error') return 'status-unavailable';
  return 'status-ready';
}

function getCommandStatusClass(status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'executing') return 'command-status-executing';
  if (normalizedStatus === 'completed') return 'command-status-completed';
  if (normalizedStatus === 'failed') return 'command-status-failed';
  return 'command-status-pending';
}

function AdminDashboard() {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [seedMessage, setSeedMessage] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [latestReading, setLatestReading] = useState(null);
  const [lastActivity, setLastActivity] = useState(null);
  const [latestCommand, setLatestCommand] = useState(null);

  useEffect(() => {
    const readingsQuery = query(collection(db, 'sensorReadings'), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribe = onSnapshot(
      readingsQuery,
      (snapshot) => {
        setLatestReading(snapshot.docs[0]?.data() || null);
      },
      () => setLatestReading(null),
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const activityQuery = query(collection(db, 'systemActivity'), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribe = onSnapshot(
      activityQuery,
      (snapshot) => {
        setLastActivity(snapshot.docs[0]?.data() || null);
      },
      () => setLastActivity(null),
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const commandsQuery = query(collection(db, 'commands'), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribe = onSnapshot(
      commandsQuery,
      (snapshot) => {
        setLatestCommand(snapshot.docs[0]?.data() || null);
      },
      () => setLatestCommand(null),
    );

    return unsubscribe;
  }, []);

  const handleLogout = async () => {
    setError('');

    try {
      await logout();
      navigate('/admin/login', { replace: true });
    } catch {
      setError('Unable to logout. Please try again.');
    }
  };

  const handleSeedProducts = async () => {
    setSeedMessage('');
    setError('');
    setSeeding(true);

    try {
      await seedProducts(db);
      setSeedMessage('Sample products seeded successfully. Refresh the products page to view them.');
    } catch {
      setError('Unable to seed sample products. Please check Firestore configuration.');
    } finally {
      setSeeding(false);
    }
  };

  const handleResetProducts = async () => {
    setSeedMessage('');
    setError('');
    setResetting(true);

    try {
      await resetProducts(db);
      setSeedMessage('Sample products reset successfully. Product catalog is now cleared.');
    } catch {
      setError('Unable to reset products. Please check Firestore configuration.');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="admin-dashboard-page">
      <section className="dashboard-hero card admin-dashboard-hero">
        <div>
          <p className="eyebrow">Admin dashboard</p>
          <h1>Warehouse operations overview</h1>
          <p className="section-copy">Monitor stock levels, activity, and control routes from a modern operational dashboard.</p>
        </div>

        <div className="dashboard-actions admin-hero-actions">
          <button className="button-secondary" type="button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </section>

      {error && <div className="error-message">{error}</div>}
      {seedMessage && <div className="success-message">{seedMessage}</div>}

      <div className="dashboard-grid admin-metrics-grid">
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Total Products</p>
          <p className="metric-value">128</p>
          <p className="metric-note">Currently catalogued in the inventory.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Pending Orders</p>
          <p className="metric-value">16</p>
          <p className="metric-note">Orders waiting for fulfillment.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Low Stock</p>
          <p className="metric-value">7</p>
          <p className="metric-note">Items below restock threshold.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Machine Status</p>
          <p className="metric-value">{latestReading?.environmentStatus || 'No Data'}</p>
          <p className="metric-note">Latest environment state from Firebase.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Latest Temperature</p>
          <p className="metric-value">{latestReading?.temperature ?? '-'}{latestReading?.temperature !== undefined ? ' C' : ''}</p>
          <p className="metric-note">From latest sensorReadings document.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Latest Humidity</p>
          <p className="metric-value">{latestReading?.humidity ?? '-'}{latestReading?.humidity !== undefined ? '%' : ''}</p>
          <p className="metric-note">From latest sensorReadings document.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Latest Gas Status</p>
          <p className="metric-value">{latestReading?.gasStatus || 'No Data'}</p>
          <p className="metric-note">MQ3/MQ135 readiness summary.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Last Activity</p>
          <p className="metric-value dashboard-activity-value">{lastActivity?.message || 'No Data'}</p>
          {lastActivity ? (
            <>
              <span className={`status-badge ${getActivityStatusClass(lastActivity.status)}`}>
                {lastActivity.status || 'info'}
              </span>
              <p className="metric-note">
                {lastActivity.sourceDevice || '-'} / {lastActivity.activityType || '-'} / {formatActivityDate(lastActivity.createdAt)}
              </p>
            </>
          ) : (
            <p className="metric-note">No system activity received yet.</p>
          )}
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Latest Command</p>
          <p className="metric-value dashboard-activity-value">{latestCommand?.command || latestCommand?.commandType || 'No Data'}</p>
          {latestCommand ? (
            <>
              <span className={`status-badge ${getCommandStatusClass(latestCommand.status)}`}>
                {latestCommand.status || 'pending'}
              </span>
              <p className="metric-note">
                {latestCommand.targetDevice || '-'} / {formatActivityDate(latestCommand.createdAt)}
              </p>
            </>
          ) : (
            <p className="metric-note">No warehouse commands created yet.</p>
          )}
        </article>
      </div>

      <section className="card admin-actions-panel">
        <div className="section-header">
          <div>
            <h2>Quick actions</h2>
            <p className="section-description">Jump straight into the most common operational workflows.</p>
          </div>
        </div>

        <div className="quick-actions-grid">
          <button className="action-card button-secondary" type="button" onClick={() => navigate('/admin/inventory')}>Inventory</button>
          <button className="action-card button-secondary" type="button" onClick={() => navigate('/admin/orders')}>Orders</button>
          <button className="action-card button-secondary" type="button" onClick={() => navigate('/admin/sensors')}>Sensors</button>
          <button className="action-card button-secondary" type="button" onClick={() => navigate('/admin/live')}>Live Activity</button>
          <button className="action-card button-secondary" type="button">Manual Control</button>
        </div>
      </section>

      <section className="card admin-activity-panel">
        <div className="section-header">
          <div>
            <h2>Recent activity</h2>
            <p className="section-description">Placeholder activity stream for system events and operational updates.</p>
          </div>
        </div>

        <div className="activity-list">
          <div className="activity-item">
            <span>09:24</span>
            <p>Product inventory sync completed.</p>
          </div>
          <div className="activity-item">
            <span>08:57</span>
            <p>New order #4082 entered the queue.</p>
          </div>
          <div className="activity-item">
            <span>07:40</span>
            <p>Machine sensor reported stable temperature.</p>
          </div>
          <div className="activity-item">
            <span>Yesterday</span>
            <p>Admin signed in from trusted device.</p>
          </div>
        </div>
      </section>

      <section className="card admin-dashboard-footer">
        <div className="dashboard-actions">
          <button className="button-primary" type="button" onClick={handleSeedProducts} disabled={seeding || resetting}>
            {seeding ? 'Seeding…' : 'Seed Products'}
          </button>
          <button className="button-secondary" type="button" onClick={handleResetProducts} disabled={seeding || resetting}>
            {resetting ? 'Resetting…' : 'Reset Products'}
          </button>
        </div>
      </section>
    </div>
  );
}

export default AdminDashboard;
