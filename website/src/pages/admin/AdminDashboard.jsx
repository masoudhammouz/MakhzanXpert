import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useAuth } from '../../context/AuthContext.jsx';
import { db } from '../../firebase/firebase.js';
import { getSellableStock, isDraftProduct } from '../../utils/productVisibility.js';

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
  if (normalizedStatus === 'sent_to_arduino') return 'command-status-executing';
  if (['done', 'executed'].includes(normalizedStatus)) return 'command-status-completed';
  if (['error', 'failed'].includes(normalizedStatus)) return 'command-status-failed';
  return 'command-status-pending';
}

function parseNumericSensorValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getDhtReading(reading, fieldName) {
  if (!reading || reading.dhtOk !== true) return null;
  return parseNumericSensorValue(reading[fieldName]);
}

function formatTemperature(value) {
  return value === null ? '-1°C' : `${value.toFixed(1)}°C`;
}

function formatHumidity(value) {
  return value === null ? '-1%' : `${value.toFixed(1)}%`;
}

function AdminDashboard() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [latestReading, setLatestReading] = useState(null);
  const [lastActivity, setLastActivity] = useState(null);
  const [recentActivities, setRecentActivities] = useState([]);
  const [latestCommand, setLatestCommand] = useState(null);
  const [dashboardStats, setDashboardStats] = useState({
    totalProducts: 0,
    pendingOrders: 0,
    lowStock: 0,
  });

  useEffect(() => {
    const readingsQuery = query(collection(db, 'sensorReadings'), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribe = onSnapshot(
      readingsQuery,
      (snapshot) => {
        const data = snapshot.docs[0]?.data() || null;
        if (data) {
          console.log('Sensor data from Firestore:', data);
        }
        setLatestReading(data);
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
    const activityQuery = query(collection(db, 'systemActivity'), orderBy('createdAt', 'desc'), limit(4));
    const unsubscribe = onSnapshot(
      activityQuery,
      (snapshot) => {
        setRecentActivities(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      },
      () => setRecentActivities([]),
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

  useEffect(() => {
    const productsQuery = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(
      productsQuery,
      (snapshot) => {
        const products = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        setDashboardStats((current) => ({
          ...current,
          totalProducts: products.length,
          lowStock: products.filter((product) => !isDraftProduct(product) && getSellableStock(product) > 0 && getSellableStock(product) <= 3).length,
        }));
      },
      () => {
        setDashboardStats((current) => ({ ...current, totalProducts: 0, lowStock: 0 }));
      },
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const ordersQuery = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(
      ordersQuery,
      (snapshot) => {
        const orders = snapshot.docs.map((item) => item.data());
        setDashboardStats((current) => ({
          ...current,
          pendingOrders: orders.filter((order) => order.status === 'pending').length,
        }));
      },
      () => {
        setDashboardStats((current) => ({ ...current, pendingOrders: 0 }));
      },
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

  const latestTemperature = getDhtReading(latestReading, 'temperature');
  const latestHumidity = getDhtReading(latestReading, 'humidity');

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

      <div className="dashboard-grid admin-metrics-grid">
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Total Products</p>
          <p className="metric-value">{dashboardStats.totalProducts}</p>
          <p className="metric-note">Currently catalogued in the inventory.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Pending Orders</p>
          <p className="metric-value">{dashboardStats.pendingOrders}</p>
          <p className="metric-note">Orders waiting for fulfillment.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Low Stock</p>
          <p className="metric-value">{dashboardStats.lowStock}</p>
          <p className="metric-note">Items below restock threshold.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Fire Status</p>
          <p className="metric-value">{latestReading?.fireStatus || latestReading?.gasStatus || 'No Data'}</p>
          <p className="metric-note">MQ3, MQ135, and temperature risk.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Latest Temperature</p>
          <p className="metric-value">{formatTemperature(latestTemperature)}</p>
          <p className="metric-note">From latest sensorReadings document.</p>
        </article>
        <article className="metric-card admin-metric-card">
          <p className="metric-label">Latest Humidity</p>
          <p className="metric-value">{formatHumidity(latestHumidity)}</p>
          <p className="metric-note">From latest sensorReadings document.</p>
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
          <p className="metric-value dashboard-activity-value">
            {latestCommand?.arduinoCommand || (latestCommand?.command === 'GO' && latestCommand?.position ? `GO ${latestCommand.position}` : latestCommand?.command) || 'No Data'}
          </p>
          {latestCommand ? (
            <>
              <span className={`status-badge ${getCommandStatusClass(latestCommand.status)}`}>
                {latestCommand.status || 'pending'}
              </span>
              <p className="metric-note">
                {latestCommand.deviceId || '-'} / {formatActivityDate(latestCommand.createdAt)}
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
            <p className="section-description">Latest system events and operational updates from Firebase.</p>
          </div>
        </div>

        <div className="activity-list">
          {recentActivities.length === 0 ? (
            <div className="activity-item">
              <span>-</span>
              <p>No recent activity.</p>
            </div>
          ) : recentActivities.map((activity) => (
            <div className="activity-item" key={activity.id}>
              <span>{formatActivityDate(activity.createdAt)}</span>
              <p>{activity.message || '-'}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default AdminDashboard;
