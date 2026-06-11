import { useEffect, useMemo, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

const ESP_DEVICE_ID = 'esp-main-01';

const RAW_POSITIONS = [
  { position: 1, label: 'GO 1' },
  { position: 2, label: 'GO 2' },
  { position: 3, label: 'GO 3' },
  { position: 4, label: 'GO 4' },
  { position: 5, label: 'GO 5' },
  { position: 6, label: 'GO 6' },
  { position: 7, label: 'GO 7' },
  { position: 8, label: 'GO 8' },
  { position: 9, label: 'GO 9' },
  { position: 10, label: 'GO 10' },
  { position: 11, label: 'GO 11' },
  { position: 12, label: 'GO 12' },
  { position: 13, label: 'GO 13' },
  { position: 14, label: 'GO 14' },
  { position: 15, label: 'GO 15' },
  { position: 16, label: 'GO 16' },
  { position: 17, label: 'GO 17' },
  { position: 18, label: 'GO 18' },
];

function getTimestampValue(value) {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return 0;
}

function formatDate(value) {
  const timestamp = getTimestampValue(value);
  if (!timestamp) return '-';

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function getCommandStatusClass(status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'sent_to_arduino') return 'command-status-executing';
  if (['done', 'executed'].includes(normalizedStatus)) return 'command-status-completed';
  if (normalizedStatus === 'failed') return 'command-status-failed';
  if (normalizedStatus === 'error') return 'command-status-failed';
  return 'command-status-pending';
}

function AdminCommands() {
  const [commands, setCommands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [executingCommand, setExecutingCommand] = useState('');

  useEffect(() => {
    const commandsQuery = query(collection(db, 'commands'), orderBy('createdAt', 'desc'), limit(50));
    const unsubscribe = onSnapshot(
      commandsQuery,
      (snapshot) => {
        setCommands(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        setLoading(false);
        setError('');
      },
      () => {
        setError('Unable to listen for warehouse commands.');
        setLoading(false);
      },
    );

    return unsubscribe;
  }, []);

  const summary = useMemo(() => ({
    total: commands.length,
    pending: commands.filter((item) => item.status === 'pending').length,
    sent: commands.filter((item) => item.status === 'sent_to_arduino').length,
    done: commands.filter((item) => ['done', 'executed'].includes(item.status)).length,
  }), [commands]);

  const handleExecuteCommand = async (commandConfig) => {
    setExecutingCommand(commandConfig.arduinoCommand);
    setError('');

    try {
      const commandRef = doc(collection(db, 'commands'));

      await setDoc(commandRef, {
        type: 'GO',
        position: commandConfig.position,
        arduinoCommand: commandConfig.arduinoCommand,
        status: 'pending',
        source: 'website',
        deviceId: ESP_DEVICE_ID,
        createdAt: serverTimestamp(),
      });
    } catch {
      setError(`Unable to create ${commandConfig.arduinoCommand} command.`);
    } finally {
      setExecutingCommand('');
    }
  };

  return (
    <div className="admin-commands-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Warehouse commands</p>
          <h1>Commands</h1>
          <p>Create ESP-compatible pending command documents for warehouse hardware.</p>
        </div>
      </section>

      {error && <p className="admin-form-error">{error}</p>}

      <section className="inventory-summary-grid" aria-label="Commands summary">
        <article className="admin-summary-card">
          <p className="metric-label">Latest 50</p>
          <p className="metric-value">{summary.total}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Pending</p>
          <p className="metric-value">{summary.pending}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Sent to Arduino</p>
          <p className="metric-value">{summary.sent}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Done</p>
          <p className="metric-value">{summary.done}</p>
        </article>
      </section>

      <section className="admin-inventory-panel" aria-label="Direct lifter position control">
        <div className="section-header">
          <div>
            <h2>Direct Lifter Position Control</h2>
            <p>Send GO 1 through GO 18 commands to {ESP_DEVICE_ID}.</p>
          </div>
        </div>

        <div className="command-card-grid">
          {RAW_POSITIONS.map((item) => (
            <article className="command-card" key={item.position}>
              <div>
                <p className="command-target">{ESP_DEVICE_ID}</p>
                <h2>{item.label}</h2>
                <code>GO {item.position}</code>
              </div>
              <button
                className="button button-primary"
                type="button"
                onClick={() => handleExecuteCommand({
                  position: item.position,
                  arduinoCommand: `GO ${item.position}`,
                })}
                disabled={Boolean(executingCommand)}
              >
                {executingCommand === `GO ${item.position}` ? 'Creating...' : 'Execute'}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-inventory-panel">
        <div className="section-header">
          <div>
            <h2>Command History</h2>
            <p>Latest 50 command documents from Firestore, updated in real time.</p>
          </div>
        </div>

        {loading ? (
          <LoadingState message="Loading command history..." />
        ) : commands.length === 0 ? (
          <EmptyState title="No commands yet" description="Execute a command to create a pending Firestore document." />
        ) : (
          <div className="inventory-table-wrap">
            <table className="inventory-table commands-table">
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Position</th>
                  <th>Status</th>
                  <th>Device ID</th>
                  <th>Created At</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((item) => (
                  <tr key={item.id}>
                    <td className="inventory-product-name">{item.arduinoCommand || '-'}</td>
                    <td>{item.position || '-'}</td>
                    <td>
                      <span className={`status-badge ${getCommandStatusClass(item.status)}`}>
                        {item.status || 'pending'}
                      </span>
                    </td>
                    <td>{item.deviceId || '-'}</td>
                    <td>{formatDate(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default AdminCommands;
