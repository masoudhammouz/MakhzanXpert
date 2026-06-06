import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

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

function getProductName(command) {
  return [command.brand, command.model, command.color, command.size ? `Size ${command.size}` : '']
    .filter(Boolean)
    .join(' ') || 'Product';
}

function AdminCommands() {
  const [commands, setCommands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadCommands() {
      setLoading(true);
      setError('');

      try {
        const commandsQuery = query(collection(db, 'commands'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(commandsQuery);
        setCommands(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      } catch {
        setError('Unable to load warehouse commands.');
      } finally {
        setLoading(false);
      }
    }

    loadCommands();
  }, []);

  const summary = useMemo(() => ({
    total: commands.length,
    pending: commands.filter((command) => command.status === 'pending').length,
    completed: commands.filter((command) => command.status === 'completed').length,
  }), [commands]);

  return (
    <div className="admin-commands-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Warehouse commands</p>
          <h1>Commands</h1>
          <p>Pending command documents prepared for a future ESP reader. Commands are not executed yet.</p>
        </div>
      </section>

      <section className="inventory-summary-grid" aria-label="Commands summary">
        <article className="admin-summary-card">
          <p className="metric-label">Total Commands</p>
          <p className="metric-value">{summary.total}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Pending</p>
          <p className="metric-value">{summary.pending}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Completed</p>
          <p className="metric-value">{summary.completed}</p>
        </article>
      </section>

      <section className="admin-inventory-panel">
        {loading ? (
          <LoadingState message="Loading commands..." />
        ) : error ? (
          <EmptyState title="Commands unavailable" description={error} />
        ) : commands.length === 0 ? (
          <EmptyState title="No commands yet" description="Prepare an order to create pending warehouse retrieval commands." />
        ) : (
          <div className="inventory-table-wrap">
            <table className="inventory-table commands-table">
              <thead>
                <tr>
                  <th>Command Type</th>
                  <th>Order ID</th>
                  <th>Product</th>
                  <th>Location ID</th>
                  <th>Status</th>
                  <th>Created At</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((command) => (
                  <tr key={command.id}>
                    <td className="inventory-product-name">{command.commandType || '-'}</td>
                    <td>{command.orderId || '-'}</td>
                    <td>{getProductName(command)}</td>
                    <td>{command.locationId ?? '-'}</td>
                    <td><span className="status-badge status-low-stock">{command.status || 'pending'}</span></td>
                    <td>{formatDate(command.createdAt)}</td>
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
