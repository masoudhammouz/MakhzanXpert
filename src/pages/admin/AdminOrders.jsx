import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';
import { formatCurrency } from '../../utils/formatCurrency.js';

const ORDER_STATUSES = ['pending', 'preparing', 'retrieving', 'ready', 'completed', 'cancelled'];

const STATUS_FLOW = ['pending', 'preparing', 'retrieving', 'ready', 'completed'];

const SAMPLE_ORDERS = [
  {
    id: 'sample-1001',
    orderId: 'ORD-1001',
    customerName: 'Omar Khalil',
    customerPhone: '+970 599 000 101',
    customerAddress: 'Ramallah, Al Tireh',
    items: [
      { productId: 'demo-1', brand: 'StridePro', model: 'XR-200', size: '9 US', color: 'Cloud White', price: 129.99, quantity: 1 },
      { productId: 'demo-2', brand: 'RunFast', model: 'Court Classic', size: '9.5 US', color: 'White / Gum', price: 104.99, quantity: 1 },
    ],
    totalPrice: 234.98,
    status: 'pending',
    createdAt: new Date('2026-06-06T10:30:00'),
    updatedAt: new Date('2026-06-06T10:30:00'),
    isSample: true,
  },
  {
    id: 'sample-1002',
    orderId: 'ORD-1002',
    customerName: 'Lina Nasser',
    customerPhone: '+970 599 000 202',
    customerAddress: 'Hebron, Ein Sarah',
    items: [
      { productId: 'demo-3', brand: 'TerraStep', model: 'Summit Guard', size: '10 US', color: 'Dark Brown', price: 164.5, quantity: 1 },
    ],
    totalPrice: 164.5,
    status: 'ready',
    createdAt: new Date('2026-06-05T15:15:00'),
    updatedAt: new Date('2026-06-06T09:05:00'),
    isSample: true,
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

function getItemsCount(order) {
  return (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

function getOrderTotal(order) {
  if (typeof order.totalPrice === 'number') return order.totalPrice;
  return (order.items || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
}

function getStatusClass(status) {
  if (status === 'cancelled') return 'status-unavailable';
  if (status === 'completed') return 'status-available';
  if (status === 'ready') return 'status-ready';
  return 'status-low-stock';
}

function sameText(left, right) {
  return (left || '').toString().trim().toLowerCase() === (right || '').toString().trim().toLowerCase();
}

function AdminOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [updatingId, setUpdatingId] = useState('');
  const [preparingId, setPreparingId] = useState('');

  useEffect(() => {
    async function loadOrders() {
      setLoading(true);
      setError('');

      try {
        const ordersQuery = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(ordersQuery);
        const firestoreOrders = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        setOrders(firestoreOrders.length > 0 ? firestoreOrders : SAMPLE_ORDERS);
      } catch {
        setOrders(SAMPLE_ORDERS);
        setError('Showing sample orders because Firestore orders could not be loaded.');
      } finally {
        setLoading(false);
      }
    }

    loadOrders();
  }, []);

  const summary = useMemo(() => ({
    pending: orders.filter((order) => order.status === 'pending').length,
    preparing: orders.filter((order) => order.status === 'preparing').length,
    ready: orders.filter((order) => order.status === 'ready').length,
    completed: orders.filter((order) => order.status === 'completed').length,
  }), [orders]);

  const filteredOrders = useMemo(() => {
    const term = searchText.trim().toLowerCase();
    return [...orders]
      .filter((order) => {
        const matchesSearch = term
          ? [
            order.orderId,
            order.customerName,
            order.customerPhone,
            order.customerAddress,
            order.status,
          ]
            .map((value) => value?.toString().toLowerCase() || '')
            .some((value) => value.includes(term))
          : true;
        const matchesStatus = statusFilter === 'all' || order.status === statusFilter;

        return matchesSearch && matchesStatus;
      })
      .sort((a, b) => getTimestampValue(b.createdAt) - getTimestampValue(a.createdAt));
  }, [orders, searchText, statusFilter]);

  const handleStatusChange = async (order, nextStatus) => {
    setUpdatingId(order.id);
    setError('');

    if (order.isSample) {
      setOrders((current) => current.map((item) => (item.id === order.id ? { ...item, status: nextStatus, updatedAt: new Date() } : item)));
      if (selectedOrder?.id === order.id) {
        setSelectedOrder((current) => ({ ...current, status: nextStatus, updatedAt: new Date() }));
      }
      setUpdatingId('');
      return;
    }

    try {
      await updateDoc(doc(db, 'orders', order.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      setOrders((current) => current.map((item) => (item.id === order.id ? { ...item, status: nextStatus, updatedAt: Date.now() } : item)));
      if (selectedOrder?.id === order.id) {
        setSelectedOrder((current) => ({ ...current, status: nextStatus, updatedAt: Date.now() }));
      }
    } catch {
      setError('Unable to update order status. Please try again.');
    } finally {
      setUpdatingId('');
    }
  };

  const findLocationForItem = async (item) => {
    const locationsQuery = query(
      collection(db, 'locations'),
      where('brand', '==', item.brand || ''),
      where('model', '==', item.model || item.name || ''),
      where('color', '==', item.color || ''),
      where('size', '==', item.size || ''),
    );
    const snapshot = await getDocs(locationsQuery);
    return snapshot.docs
      .map((locationDoc) => ({ id: locationDoc.id, ...locationDoc.data() }))
      .find((location) =>
        location.isOccupied &&
        sameText(location.brand, item.brand) &&
        sameText(location.model, item.model || item.name) &&
        sameText(location.color, item.color) &&
        sameText(location.size, item.size),
      );
  };

  const handlePrepareOrder = async (order) => {
    if (order.isSample) {
      setError('Sample orders cannot create warehouse commands.');
      return;
    }

    setPreparingId(order.id);
    setError('');

    try {
      const items = order.items || [];
      const commandWrites = [];
      const missingItems = [];

      for (const item of items) {
        const location = await findLocationForItem(item);
        if (!location) {
          missingItems.push([item.brand, item.model || item.name, item.color, item.size].filter(Boolean).join(' '));
          continue;
        }

        commandWrites.push(addDoc(collection(db, 'commands'), {
          commandType: 'RETRIEVE_PRODUCT',
          orderId: order.orderId || order.id,
          productId: item.productId || '',
          brand: item.brand || '',
          model: item.model || item.name || '',
          color: item.color || '',
          size: item.size || '',
          quantity: Number(item.quantity || 0),
          locationId: Number(location.locationId),
          status: 'pending',
          createdAt: serverTimestamp(),
          completedAt: null,
        }));
      }

      if (commandWrites.length > 0) {
        await Promise.all(commandWrites);
        await updateDoc(doc(db, 'orders', order.id), {
          status: 'retrieving',
          updatedAt: serverTimestamp(),
        });
        setOrders((current) => current.map((item) => (item.id === order.id ? { ...item, status: 'retrieving', updatedAt: Date.now() } : item)));
        if (selectedOrder?.id === order.id) {
          setSelectedOrder((current) => ({ ...current, status: 'retrieving', updatedAt: Date.now() }));
        }
      }

      if (missingItems.length > 0) {
        setError(`No matching warehouse location found for: ${missingItems.join(', ')}.`);
      }
    } catch {
      setError('Unable to prepare order. Please check warehouse locations and try again.');
    } finally {
      setPreparingId('');
    }
  };

  return (
    <div className="admin-orders-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Orders management</p>
          <h1>Orders</h1>
          <p>Track customer orders and move fulfillment status through the warehouse workflow.</p>
        </div>
      </section>

      <section className="inventory-summary-grid" aria-label="Orders summary">
        <article className="admin-summary-card">
          <p className="metric-label">Pending Orders</p>
          <p className="metric-value">{summary.pending}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Preparing Orders</p>
          <p className="metric-value">{summary.preparing}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Ready Orders</p>
          <p className="metric-value">{summary.ready}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Completed Orders</p>
          <p className="metric-value">{summary.completed}</p>
        </article>
      </section>

      <section className="admin-inventory-panel">
        <div className="inventory-toolbar">
          <div className="admin-search-field">
            <label htmlFor="orders-search">Search orders</label>
            <input
              id="orders-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Order ID, customer, phone, address"
              type="search"
            />
          </div>

          <div className="inventory-filters orders-filter-row">
            <label>
              Status
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="all">All</option>
                {ORDER_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {loading ? (
          <LoadingState message="Loading orders..." />
        ) : (
          <>
            {error && <p className="admin-form-error">{error}</p>}
            {filteredOrders.length === 0 ? (
              <EmptyState title="No orders found" description="Try changing the search term or status filter." />
            ) : (
              <>
                <p className="inventory-result-count">{filteredOrders.length} order{filteredOrders.length === 1 ? '' : 's'} shown</p>
                <div className="inventory-table-wrap">
                  <table className="inventory-table orders-table">
                    <thead>
                      <tr>
                        <th>Order ID</th>
                        <th>Customer</th>
                        <th>Items Count</th>
                        <th>Total Price</th>
                        <th>Status</th>
                        <th>Created Date</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOrders.map((order) => (
                        <tr key={order.id}>
                          <td className="inventory-product-name">{order.orderId || order.id}</td>
                          <td>
                            <strong>{order.customerName || '-'}</strong>
                            <p className="orders-customer-meta">{order.customerPhone || '-'}</p>
                          </td>
                          <td>{getItemsCount(order)}</td>
                          <td>{formatCurrency(getOrderTotal(order))}</td>
                          <td>
                            <span className={`status-badge ${getStatusClass(order.status)}`}>{order.status || 'pending'}</span>
                          </td>
                          <td>{formatDate(order.createdAt)}</td>
                          <td>
                            <div className="inventory-actions order-actions">
                              <button type="button" onClick={() => setSelectedOrder(order)}>View Details</button>
                              <button
                                type="button"
                                disabled={preparingId === order.id || order.status === 'retrieving' || order.status === 'completed' || order.status === 'cancelled'}
                                onClick={() => handlePrepareOrder(order)}
                              >
                                {preparingId === order.id ? 'Preparing...' : 'Prepare Order'}
                              </button>
                              <select
                                value={order.status || 'pending'}
                                disabled={updatingId === order.id}
                                onChange={(event) => handleStatusChange(order, event.target.value)}
                                aria-label={`Update status for ${order.orderId || order.id}`}
                              >
                                {ORDER_STATUSES.map((status) => (
                                  <option key={status} value={status}>{status}</option>
                                ))}
                              </select>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>

      {selectedOrder && (
        <div className="order-modal-backdrop" onClick={() => setSelectedOrder(null)}>
          <section className="order-details-modal" onClick={(event) => event.stopPropagation()}>
            <div className="order-modal-header">
              <div>
                <p className="section-eyebrow">Order details</p>
                <h2>{selectedOrder.orderId || selectedOrder.id}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setSelectedOrder(null)} aria-label="Close order details">
                Close
              </button>
            </div>

            <div className="order-details-grid">
              <article>
                <p className="spec-label">Customer</p>
                <p className="spec-value">{selectedOrder.customerName || '-'}</p>
                <p>{selectedOrder.customerPhone || '-'}</p>
                <p>{selectedOrder.customerAddress || '-'}</p>
              </article>
              <article>
                <p className="spec-label">Current status</p>
                <span className={`status-badge ${getStatusClass(selectedOrder.status)}`}>{selectedOrder.status || 'pending'}</span>
                <label className="order-modal-status">
                  Update Status
                  <select
                    value={selectedOrder.status || 'pending'}
                    disabled={updatingId === selectedOrder.id}
                    onChange={(event) => handleStatusChange(selectedOrder, event.target.value)}
                  >
                    {STATUS_FLOW.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </label>
              </article>
            </div>

            <div className="ordered-products-list">
              <h3>Ordered products</h3>
              {(selectedOrder.items || []).map((item, index) => (
                <div className="ordered-product-row" key={item.productId || `${selectedOrder.id}-${index}`}>
                  <div>
                    <p className="inventory-product-name">{[item.brand, item.model || item.name].filter(Boolean).join(' ') || 'Product'}</p>
                    <p className="orders-customer-meta">{[item.size, item.color].filter(Boolean).join(' / ')}</p>
                  </div>
                  <p>Qty {Number(item.quantity || 0)}</p>
                  <p>{formatCurrency(Number(item.price || 0) * Number(item.quantity || 0))}</p>
                </div>
              ))}
            </div>

            <div className="order-modal-total">
              <p className="spec-label">Total price</p>
              <p className="cart-total">{formatCurrency(getOrderTotal(selectedOrder))}</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default AdminOrders;
