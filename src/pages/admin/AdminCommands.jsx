import { useEffect, useMemo, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

const ESP_DEVICE_ID = 'esp-main-01';

const COMMANDS = [
  {
    command: 'BELT_START',
    name: 'Belt Start',
    description: 'Start the warehouse conveyor line.',
    deviceId: ESP_DEVICE_ID,
  },
  {
    command: 'BELT_STOP',
    name: 'Belt Stop',
    description: 'Stop the warehouse conveyor line.',
    deviceId: ESP_DEVICE_ID,
  },
  {
    command: 'CAMERA',
    name: 'Camera',
    description: 'Activate the camera scanner.',
    deviceId: ESP_DEVICE_ID,
  },
  {
    command: 'SCAN',
    name: 'Scan Label',
    description: 'Request a label scan from the camera system.',
    deviceId: ESP_DEVICE_ID,
  },
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
  if (normalizedStatus === 'executing') return 'command-status-executing';
  if (normalizedStatus === 'completed') return 'command-status-completed';
  if (normalizedStatus === 'failed') return 'command-status-failed';
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
    executing: commands.filter((item) => item.status === 'executing').length,
    completed: commands.filter((item) => item.status === 'completed').length,
  }), [commands]);

  const handleExecuteCommand = async (commandConfig) => {
    setExecutingCommand(commandConfig.command);
    setError('');

    try {
      const commandRef = doc(collection(db, 'commands'));

      await setDoc(commandRef, {
        commandId: commandRef.id,
        deviceId: ESP_DEVICE_ID,
        command: commandConfig.command,
        status: 'pending',
        payload: {},
        response: '',
        createdAt: serverTimestamp(),
        executedAt: null,
      });
    } catch {
      setError(`Unable to create ${commandConfig.command} command.`);
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
          <p className="metric-label">Executing</p>
          <p className="metric-value">{summary.executing}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Completed</p>
          <p className="metric-value">{summary.completed}</p>
        </article>
      </section>

      <section className="command-card-grid" aria-label="Supported warehouse commands">
        {COMMANDS.map((item) => (
          <article className="command-card" key={item.command}>
            <div>
              <p className="command-target">{item.deviceId}</p>
              <h2>{item.name}</h2>
              <p>{item.description}</p>
              <code>{item.command}</code>
            </div>
            <button
              className="button button-primary"
              type="button"
              onClick={() => handleExecuteCommand(item)}
              disabled={Boolean(executingCommand)}
            >
              {executingCommand === item.command ? 'Creating...' : 'Execute'}
            </button>
          </article>
        ))}
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
                  <th>Status</th>
                  <th>Device ID</th>
                  <th>Created At</th>
                  <th>Executed At</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((item) => (
                  <tr key={item.id}>
                    <td className="inventory-product-name">{item.command || item.commandType || '-'}</td>
                    <td>
                      <span className={`status-badge ${getCommandStatusClass(item.status)}`}>
                        {item.status || 'pending'}
                      </span>
                    </td>
                    <td>{item.deviceId || '-'}</td>
                    <td>{formatDate(item.createdAt)}</td>
                    <td>{formatDate(item.executedAt)}</td>
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
