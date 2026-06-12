import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
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

function getStatusClass(status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'success') return 'status-available';
  if (normalizedStatus === 'warning') return 'status-low-stock';
  if (normalizedStatus === 'error') return 'status-unavailable';
  return 'status-ready';
}

function AdminLiveActivity() {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const activityQuery = query(collection(db, 'systemActivity'), orderBy('createdAt', 'desc'), limit(50));
    const unsubscribe = onSnapshot(
      activityQuery,
      (snapshot) => {
        setActivities(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        setLoading(false);
      },
      () => {
        setError('Unable to listen for live system activity.');
        setLoading(false);
      },
    );

    return unsubscribe;
  }, []);

  return (
    <div className="admin-live-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Live system activity</p>
          <h1>Live Activity</h1>
          <p>Real-time Firebase feed for machine, camera, dispenser, conveyor, lift, and sensor events.</p>
        </div>
      </section>

      <section className="admin-inventory-panel">
        {loading ? (
          <LoadingState message="Loading live activity..." />
        ) : activities.length === 0 ? (
          <EmptyState title="No activity yet" description="Wait for devices to write systemActivity events." />
        ) : (
          <>
            {error && <p className="admin-form-error">{error}</p>}
            <div className="live-activity-feed">
              {activities.map((activity) => (
                <article className="live-activity-item" key={activity.id}>
                  <div>
                    <span className={`status-badge ${getStatusClass(activity.status)}`}>{activity.status || 'info'}</span>
                    <h2>{activity.message || '-'}</h2>
                    <p>
                      <strong>{activity.sourceDevice || '-'}</strong>
                      <span>{activity.activityType || '-'}</span>
                    </p>
                  </div>
                  <time>{formatDate(activity.createdAt)}</time>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default AdminLiveActivity;
