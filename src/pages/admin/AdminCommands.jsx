import { useEffect, useMemo, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

const COMMANDS = [
  {
    command: 'CONVEYOR_START',
    name: 'Conveyor Start',
    description: 'Start the warehouse conveyor line.',
    targetDevice: 'Conveyor',
  },
  {
    command: 'CONVEYOR_STOP',
    name: 'Conveyor Stop',
    description: 'Stop the warehouse conveyor line.',
    targetDevice: 'Conveyor',
  },
  {
    command: 'CAMERA_START',
    name: 'Camera Start',
    description: 'Activate the camera scanner.',
    targetDevice: 'Camera Scanner',
  },
  {
    command: 'CAMERA_STOP',
    name: 'Camera Stop',
    description: 'Stop the camera scanner.',
    targetDevice: 'Camera Scanner',
  },
  {
    command: 'SCAN_LABEL',
    name: 'Scan Label',
    description: 'Request a label scan from the camera system.',
    targetDevice: 'Camera Scanner',
  },
  {
    command: 'STORAGE_START',
    name: 'Storage Start',
    description: 'Start the storage handling system.',
    targetDevice: 'Storage System',
  },
  {
    command: 'STORAGE_STOP',
    name: 'Storage Stop',
    description: 'Stop the storage handling system.',
    targetDevice: 'Storage System',
  },
  {
    command: 'RETRIEVE_PRODUCT',
    name: 'Retrieve Product',
    description: 'Queue a product retrieval command for warehouse hardware.',
    targetDevice: 'Lift System',
  },
  {
    command: 'EMERGENCY_STOP',
    name: 'Emergency Stop',
    description: 'Immediately request all warehouse hardware to stop.',
    targetDevice: 'All Devices',
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
        command: commandConfig.command,
        targetDevice: commandConfig.targetDevice,
        status: 'pending',
        createdAt: serverTimestamp(),
        executedAt: null,
        response: '',
        payload: {},
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
          <p>Create pending command documents for warehouse hardware. ESP integration is not connected yet.</p>
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
          <article className={item.command === 'EMERGENCY_STOP' ? 'command-card emergency-command-card' : 'command-card'} key={item.command}>
            <div>
              <p className="command-target">{item.targetDevice}</p>
              <h2>{item.name}</h2>
              <p>{item.description}</p>
              <code>{item.command}</code>
            </div>
            <button
              className={item.command === 'EMERGENCY_STOP' ? 'button button-danger' : 'button button-primary'}
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
                  <th>Target Device</th>
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
                    <td>{item.targetDevice || '-'}</td>
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
