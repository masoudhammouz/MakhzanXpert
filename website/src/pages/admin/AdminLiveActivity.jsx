import { addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

const SAMPLE_ACTIVITIES = [
  ['ESP Main Controller', 'device', 'ESP Main Controller online', 'success'],
  ['Sensor Hub', 'sensor', 'Sensor readings updated', 'info'],
  ['Conveyor', 'conveyor', 'Conveyor ready', 'success'],
  ['Camera Scanner', 'camera', 'Camera scanner idle', 'info'],
  ['Lift System', 'lift', 'Lift system waiting', 'warning'],
];

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
  const [seeding, setSeeding] = useState(false);

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

  const handleSeedActivity = async () => {
    setSeeding(true);
    setError('');

    try {
      await Promise.all(
        SAMPLE_ACTIVITIES.map((sample) => addDoc(collection(db, 'systemActivity'), {
          sourceDevice: sample[0],
          activityType: sample[1],
          message: sample[2],
          status: sample[3],
          relatedOrderId: '',
          relatedCommandId: '',
          createdAt: serverTimestamp(),
        })),
      );
    } catch {
      setError('Unable to seed activity.');
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="admin-live-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Live system activity</p>
          <h1>Live Activity</h1>
          <p>Real-time Firebase feed for machine, camera, dispenser, conveyor, lift, and sensor events.</p>
        </div>
        <button className="button button-primary" type="button" onClick={handleSeedActivity} disabled={seeding}>
          {seeding ? 'Seeding...' : 'Seed Activity'}
        </button>
      </section>

      <section className="admin-inventory-panel">
        {loading ? (
          <LoadingState message="Loading live activity..." />
        ) : activities.length === 0 ? (
          <EmptyState title="No activity yet" description="Seed a test activity or wait for devices to write systemActivity events." />
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
