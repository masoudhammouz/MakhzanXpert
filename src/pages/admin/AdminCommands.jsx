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

const RAW_POSITIONS = [
  { command: 'GO 1', label: 'P1 IN' },
  { command: 'GO 2', label: 'P1 OUT' },
  { command: 'GO 3', label: 'P2 IN' },
  { command: 'GO 4', label: 'P2 OUT' },
  { command: 'GO 5', label: 'P3 IN' },
  { command: 'GO 6', label: 'P3 OUT' },
  { command: 'GO 7', label: 'P4 IN' },
  { command: 'GO 8', label: 'P4 OUT' },
  { command: 'GO 9', label: 'P5 IN' },
  { command: 'GO 10', label: 'P5 OUT' },
  { command: 'GO 11', label: 'P6 IN' },
  { command: 'GO 12', label: 'P6 OUT' },
  { command: 'GO 13', label: 'P7 IN' },
  { command: 'GO 14', label: 'P7 OUT' },
  { command: 'GO 15', label: 'P8 IN' },
  { command: 'GO 16', label: 'P8 OUT' },
  { command: 'GO 17', label: 'P9 IN' },
  { command: 'GO 18', label: 'P9 OUT' },
];

const LIFTER_HOME_COMMANDS = [
  { command: 'HOME', label: 'HOME' },
  { command: 'START', label: 'STARTING POINT' },
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
        payload: commandConfig.payload || {},
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

      <section className="admin-inventory-panel" aria-label="Direct lifter position control">
        <div className="section-header">
          <div>
            <h2>Direct Lifter Position Control</h2>
            <p>Send raw Arduino lifter position commands directly to {ESP_DEVICE_ID}.</p>
          </div>
        </div>

        <div className="command-card-grid">
          {LIFTER_HOME_COMMANDS.map((item) => (
            <article className="command-card" key={item.command}>
              <div>
                <p className="command-target">{ESP_DEVICE_ID}</p>
                <h2>{item.label}</h2>
                <code>{item.command}</code>
              </div>
              <button
                className="button button-primary"
                type="button"
                onClick={() => handleExecuteCommand({
                  command: item.command,
                  payload: {
                    source: 'admin_direct_lifter_control',
                    positionLabel: item.label,
                  },
                })}
                disabled={Boolean(executingCommand)}
              >
                {executingCommand === item.command ? 'Creating...' : 'Execute'}
              </button>
            </article>
          ))}

          {RAW_POSITIONS.map((item) => (
            <article className="command-card" key={item.command}>
              <div>
                <p className="command-target">{ESP_DEVICE_ID}</p>
                <h2>{item.label}</h2>
                <code>{item.command}</code>
              </div>
              <button
                className="button button-primary"
                type="button"
                onClick={() => handleExecuteCommand({
                  command: item.command,
                  payload: {
                    source: 'admin_direct_lifter_control',
                    positionLabel: item.label,
                  },
                })}
                disabled={Boolean(executingCommand)}
              >
                {executingCommand === item.command ? 'Creating...' : 'Execute'}
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
                  <th>Status</th>
                  <th>Device ID</th>
                  <th>Created At</th>
                  <th>Executed At</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((item) => (
                  <tr key={item.id}>
                    <td className="inventory-product-name">{item.command || '-'}</td>
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
