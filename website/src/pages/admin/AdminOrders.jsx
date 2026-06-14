import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { markPickedLocationEmpty } from '../../utils/inventorySync.js';
import { buildNormalizedSku } from '../../utils/productVisibility.js';

const ESP_DEVICE_ID = 'esp-main-01';
const PICK_COMMAND = 'PICK_LOCATION';
const ORDER_STATUSES = ['pending', 'preparing', 'retrieving', 'ready', 'completed', 'cancelled'];
const COMPLETABLE_STATUSES = ['ready', 'completed'];

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

function normalize(value) {
  return String(value || '').trim().toUpperCase();
}

function buildProductKey(item) {
  return item.productKey || ['brand', 'model', 'color', 'size'].map((field) => normalize(item[field] || (field === 'model' ? item.name : ''))).join('|');
}

function productLabel(item) {
  return buildProductKey(item).split('|').filter(Boolean).join(' ');
}

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function compactIdentityValues(values) {
  return new Set(values.map(normalizeIdentity).filter(Boolean));
}

function itemIdentityValues(item) {
  return compactIdentityValues([
    item?.id,
    item?.productId,
    item?.sku,
    item?.normalizedSku,
    item?.productKey,
    buildProductKey(item),
    buildNormalizedSku(item),
  ]);
}

function locationIdentityValues(location) {
  return compactIdentityValues([
    location?.productId,
    location?.sku,
    location?.normalizedSku,
    location?.productKey,
    buildNormalizedSku(location),
  ]);
}

function identitiesOverlap(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function getItemsCount(order) {
  return (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

function getOrderTotal(order) {
  if (typeof order.totalPrice === 'number') return order.totalPrice;
  return (order.items || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
}

function getRetrievalTotal(order) {
  return Number(order.retrievalTotal ?? getItemsCount(order) ?? 0);
}

function getRetrievedCount(order) {
  return Number(order.retrievalDone ?? 0);
}

function getProgressLabel(order) {
  const total = getRetrievalTotal(order);
  if (!total) return '-';
  return `${getRetrievedCount(order)} / ${total} Retrieved`;
}

function getStatusClass(status) {
  if (status === 'cancelled') return 'status-unavailable';
  if (status === 'completed') return 'status-available';
  if (status === 'ready') return 'status-ready';
  return 'status-low-stock';
}

function isLocationMatch(location, item) {
  const identityMatch = identitiesOverlap(itemIdentityValues(item), locationIdentityValues(location));
  if (identityMatch) return true;

  return (
    normalize(location.brand) === normalize(item.brand) &&
    normalize(location.model) === normalize(item.model || item.name) &&
    normalize(location.color) === normalize(item.color) &&
    normalize(location.size) === normalize(item.size)
  );
}

function isPickableLocation(location) {
  return (
    String(location.status || '').toLowerCase() === 'full' &&
    (location.occupied === true || location.isOccupied === true)
  );
}

function isLocationReservedForOrder(location, order) {
  return (
    String(location.reservedForOrder || '') === String(order.id) ||
    String(location.reservedForOrderId || '') === String(order.orderId || order.id)
  );
}

function isLocationReservedForAnotherOrder(location, order) {
  return Boolean(location.reservedForOrder || location.reservedForOrderId) && !isLocationReservedForOrder(location, order);
}

function getLocationNumber(location) {
  const value = Number(location.locationId ?? location.position ?? location.id);
  return Number.isInteger(value) && value >= 1 && value <= 9 ? value : 0;
}

function sortOldestFilledFirst(left, right) {
  const leftFilledAt = getTimestampValue(left.filledAt);
  const rightFilledAt = getTimestampValue(right.filledAt);
  if (leftFilledAt !== rightFilledAt) return leftFilledAt - rightFilledAt;
  return getLocationNumber(left) - getLocationNumber(right);
}

function expandOrderItems(items) {
  return (items || []).flatMap((item, itemIndex) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    return Array.from({ length: quantity }, (_, unitIndex) => ({
      ...item,
      itemIndex,
      unitIndex,
      itemKey: `${item.productId || buildProductKey(item)}-${itemIndex}-${unitIndex}`,
    }));
  });
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
  const finalizingCommandIds = useRef(new Set());

  useEffect(() => {
    setLoading(true);
    setError('');

    const ordersQuery = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(
      ordersQuery,
      (snapshot) => {
        setOrders(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        setLoading(false);
      },
      () => {
        setOrders([]);
        setError('Unable to load orders from Firebase.');
        setLoading(false);
      },
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!selectedOrder) return;
    const latest = orders.find((order) => order.id === selectedOrder.id);
    if (latest) setSelectedOrder(latest);
  }, [orders, selectedOrder?.id]);

  const summary = useMemo(() => ({
    pending: orders.filter((order) => (order.status || 'pending') === 'pending').length,
    retrieving: orders.filter((order) => ['preparing', 'retrieving'].includes(order.status)).length,
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
        return matchesSearch && (statusFilter === 'all' || (order.status || 'pending') === statusFilter);
      })
      .sort((a, b) => getTimestampValue(b.createdAt) - getTimestampValue(a.createdAt));
  }, [orders, searchText, statusFilter]);

  const refreshSelectedOrder = (orderId, updates) => {
    setOrders((current) => current.map((item) => (item.id === orderId ? { ...item, ...updates, updatedAt: Date.now() } : item)));
    if (selectedOrder?.id === orderId) {
      setSelectedOrder((current) => ({ ...current, ...updates, updatedAt: Date.now() }));
    }
  };

  const finalizePickCommand = async (command) => {
    if (!command?.id || finalizingCommandIds.current.has(command.id) || command.finalizedAt) return;
    finalizingCommandIds.current.add(command.id);

    try {
      await markPickedLocationEmpty(command.locationId || command.locationNumber, {
        orderId: command.orderId,
        commandId: command.commandId || command.id,
        arduinoCommand: command.arduinoCommand,
      });

      await updateDoc(doc(db, 'commands', command.id), {
        finalizedAt: serverTimestamp(),
        finalizedStatus: 'location_cleared',
        updatedAt: serverTimestamp(),
      });

      const orderCommandsSnapshot = await getDocs(query(collection(db, 'commands'), where('orderId', '==', command.orderId)));
      const pickCommands = orderCommandsSnapshot.docs
        .map((commandDoc) => ({ id: commandDoc.id, ...commandDoc.data() }))
        .filter((item) => item.type === PICK_COMMAND || item.command === PICK_COMMAND || String(item.arduinoCommand || '').startsWith(`${PICK_COMMAND} `));
      const doneCommands = pickCommands.filter((item) => ['done', 'completed', 'executed', 'picked'].includes(item.status) || item.id === command.id);
      const allDone = pickCommands.length > 0 && doneCommands.length === pickCommands.length;

      const assignedLocations = pickCommands.map((item) => ({
        orderItemKey: item.orderItemKey,
        productKey: item.productKey,
        productId: item.productId || '',
        locationId: item.locationId,
        locationNumber: item.locationNumber,
        status: ['done', 'completed', 'executed', 'picked'].includes(item.status) || item.id === command.id ? 'picked' : (item.status || 'waiting'),
        commandId: item.commandId || item.id,
      }));

      const orderUpdates = {
        retrievalDone: doneCommands.length,
        retrievalProgressLabel: `${doneCommands.length} / ${pickCommands.length} Retrieved`,
        assignedBoxes: assignedLocations,
        updatedAt: serverTimestamp(),
      };

      if (allDone) {
        orderUpdates.status = 'ready';
        orderUpdates.readyAt = serverTimestamp();
      }

      await updateDoc(doc(db, 'orders', command.orderId), orderUpdates);
      refreshSelectedOrder(command.orderId, {
        ...orderUpdates,
        updatedAt: Date.now(),
        readyAt: allDone ? Date.now() : undefined,
      });
    } catch (finalizeError) {
      console.error('[PICK_ORDER_FINALIZE_FAILED]', command, finalizeError);
    } finally {
      finalizingCommandIds.current.delete(command.id);
    }
  };

  useEffect(() => {
    const commandsQuery = query(collection(db, 'commands'), orderBy('createdAt', 'desc'), limit(80));
    const unsubscribe = onSnapshot(commandsQuery, (snapshot) => {
      snapshot.docs
        .map((commandDoc) => ({ id: commandDoc.id, ...commandDoc.data() }))
        .filter((command) => (
          command.orderId &&
          !command.finalizedAt &&
          ['done', 'completed', 'executed', 'picked'].includes(command.status) &&
          (command.type === PICK_COMMAND || command.command === PICK_COMMAND || String(command.arduinoCommand || '').startsWith(`${PICK_COMMAND} `))
        ))
        .forEach((command) => {
          finalizePickCommand(command);
        });
    });

    return unsubscribe;
  }, []);

  const handleStatusChange = async (order, nextStatus) => {
    if (!COMPLETABLE_STATUSES.includes(nextStatus)) return;
    setUpdatingId(order.id);
    setError('');

    try {
      await updateDoc(doc(db, 'orders', order.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      refreshSelectedOrder(order.id, { status: nextStatus });
    } catch {
      setError('Unable to update order status. Please try again.');
    } finally {
      setUpdatingId('');
    }
  };

  const findLocationsForOrder = async (order) => {
    const locationsSnapshot = await getDocs(collection(db, 'locations'));
    const availableLocations = locationsSnapshot.docs
      .map((locationDoc) => ({ id: locationDoc.id, ref: locationDoc.ref, ...locationDoc.data() }))
      .filter((location) => (
        isPickableLocation(location) &&
        getLocationNumber(location) > 0 &&
        !isLocationReservedForAnotherOrder(location, order)
      ))
      .sort(sortOldestFilledFirst);

    const assignedLocationIds = new Set();
    const assignments = [];
    const missingItems = [];

    for (const item of expandOrderItems(order.items)) {
      const reservedMatches = availableLocations.filter((location) => (
        !assignedLocationIds.has(location.id) &&
        isLocationReservedForOrder(location, order) &&
        isLocationMatch(location, item)
      ));
      const fallbackMatches = availableLocations.filter((location) => (
        !assignedLocationIds.has(location.id) &&
        !location.reservedForOrder &&
        !location.reservedForOrderId &&
        isLocationMatch(location, item)
      ));
      const match = reservedMatches[0] || fallbackMatches[0];
      if (!match) {
        missingItems.push(productLabel(item));
        continue;
      }

      const locationNumber = getLocationNumber(match);
      assignedLocationIds.add(match.id);
      assignments.push({
        orderItemKey: item.itemKey,
        productKey: buildProductKey(item),
        productId: item.productId || '',
        sku: item.sku || '',
        normalizedSku: item.normalizedSku || buildNormalizedSku(item),
        brand: normalize(item.brand),
        model: normalize(item.model || item.name),
        color: normalize(item.color),
        size: normalize(item.size),
        locationId: match.id,
        locationRef: match.ref,
        locationNumber,
        wasReservedForOrder: isLocationReservedForOrder(match, order),
        status: 'waiting',
      });
    }

    return { assignments, missingItems };
  };

  const handlePrepareOrder = async (order) => {
    setPreparingId(order.id);
    setError('');
    console.info('[PREPARE_ORDER_CLICKED]', { orderId: order.id, orderNumber: order.orderId || order.id });

    try {
      const { assignments, missingItems } = await findLocationsForOrder(order);
      if (missingItems.length > 0) {
        setError('No available warehouse location for this product.');
        return;
      }
      if (assignments.length === 0) {
        setError('This order has no retrievable items.');
        return;
      }

      const batch = writeBatch(db);
      const assignedLocations = assignments.map((assignment) => {
        const commandRef = doc(collection(db, 'commands'));
        const commandId = commandRef.id;
        const arduinoCommand = `${PICK_COMMAND} ${assignment.locationNumber}`;

        batch.set(commandRef, {
          commandId,
          type: PICK_COMMAND,
          command: PICK_COMMAND,
          arduinoCommand,
          deviceId: ESP_DEVICE_ID,
          status: 'pending',
          locationId: assignment.locationId,
          locationNumber: assignment.locationNumber,
          position: assignment.locationNumber,
          orderId: order.id,
          orderNumber: order.orderId || order.id,
          orderItemKey: assignment.orderItemKey,
          productKey: assignment.productKey,
          productId: assignment.productId,
          sku: assignment.sku,
          normalizedSku: assignment.normalizedSku,
          brand: assignment.brand,
          model: assignment.model,
          color: assignment.color,
          size: assignment.size,
          payload: {
            orderId: order.id,
            orderNumber: order.orderId || order.id,
            locationId: assignment.locationId,
            locationNumber: assignment.locationNumber,
            productId: assignment.productId,
            sku: assignment.sku || assignment.normalizedSku,
            arduinoCommand,
          },
          source: 'admin-prepare-order',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (assignment.locationRef) {
          batch.set(assignment.locationRef, {
            reservedForOrder: order.id,
            reservedForOrderId: order.orderId || order.id,
            updatedAt: serverTimestamp(),
          }, { merge: true });
          console.info('[ORDER_LOCATION_RESERVED]', {
            orderId: order.id,
            orderNumber: order.orderId || order.id,
            locationId: assignment.locationId,
            locationNumber: assignment.locationNumber,
            alreadyReserved: assignment.wasReservedForOrder,
          });
        }

        console.info('[PICK_COMMAND_CREATED]', {
          commandId,
          arduinoCommand,
          orderId: order.id,
          locationId: assignment.locationId,
          locationNumber: assignment.locationNumber,
          productKey: assignment.productKey,
        });

        return {
          orderItemKey: assignment.orderItemKey,
          productKey: assignment.productKey,
          productId: assignment.productId,
          sku: assignment.sku,
          normalizedSku: assignment.normalizedSku,
          brand: assignment.brand,
          model: assignment.model,
          color: assignment.color,
          size: assignment.size,
          locationId: assignment.locationId,
          locationNumber: assignment.locationNumber,
          status: assignment.status,
          commandId,
          arduinoCommand,
        };
      });

      const updates = {
        status: 'preparing',
        retrievalTotal: assignments.length,
        retrievalDone: 0,
        retrievalProgressLabel: `0 / ${assignments.length} Retrieved`,
        assignedBoxes: assignedLocations,
        pickedLocationId: assignedLocations[0]?.locationId || '',
        pickedLocationNumber: assignedLocations[0]?.locationNumber || 0,
        preparingAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      batch.update(doc(db, 'orders', order.id), updates);
      await batch.commit();
      refreshSelectedOrder(order.id, { ...updates, preparingAt: Date.now(), updatedAt: Date.now() });
    } catch {
      setError('Unable to prepare order. Please check stored inventory and try again.');
    } finally {
      setPreparingId('');
    }
  };

  const handleCancelOrder = async (order) => {
    if (!['pending', 'preparing', 'retrieving'].includes(order.status || 'pending')) return;
    setUpdatingId(order.id);
    setError('');

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'orders', order.id), {
        status: 'cancelled',
        cancelRemainingPickTasks: true,
        cancelledAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const commandsSnapshot = await getDocs(query(collection(db, 'commands'), where('orderId', '==', order.id)));
      commandsSnapshot.docs.forEach((commandDoc) => {
        const status = commandDoc.data().status;
        if (!['done', 'picked', 'error'].includes(status)) {
          batch.update(commandDoc.ref, {
            status: 'cancelled',
            updatedAt: serverTimestamp(),
          });
        }
      });

      await batch.commit();
      refreshSelectedOrder(order.id, { status: 'cancelled', cancelRemainingPickTasks: true });
    } catch {
      setError('Unable to cancel order retrieval.');
    } finally {
      setUpdatingId('');
    }
  };

  return (
    <div className="admin-orders-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Orders management</p>
          <h1>Orders</h1>
          <p>Prepare orders by product and location. Operators never need Box IDs.</p>
        </div>
      </section>

      <section className="inventory-summary-grid" aria-label="Orders summary">
        <article className="admin-summary-card">
          <p className="metric-label">Pending</p>
          <p className="metric-value">{summary.pending}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Retrieving</p>
          <p className="metric-value">{summary.retrieving}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Ready</p>
          <p className="metric-value">{summary.ready}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Completed</p>
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
                        <th>Items</th>
                        <th>Total</th>
                        <th>Status</th>
                        <th>Retrieval</th>
                        <th>Created</th>
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
                          <td>{order.status === 'ready' ? 'Ready For Pickup' : getProgressLabel(order)}</td>
                          <td>{formatDate(order.createdAt)}</td>
                          <td>
                            <div className="inventory-actions order-actions">
                              <button type="button" onClick={() => setSelectedOrder(order)}>View Details</button>
                              <button
                                type="button"
                                disabled={preparingId === order.id || (order.status || 'pending') !== 'pending'}
                                onClick={() => handlePrepareOrder(order)}
                              >
                                {preparingId === order.id ? 'Preparing...' : 'Prepare Order'}
                              </button>
                              {order.status === 'ready' && (
                                <button type="button" disabled={updatingId === order.id} onClick={() => handleStatusChange(order, 'completed')}>
                                  Complete
                                </button>
                              )}
                              {['pending', 'preparing', 'retrieving'].includes(order.status || 'pending') && (
                                <button className="button-danger" type="button" disabled={updatingId === order.id} onClick={() => handleCancelOrder(order)}>
                                  Cancel
                                </button>
                              )}
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
                <p className="spec-label">Fulfillment</p>
                <span className={`status-badge ${getStatusClass(selectedOrder.status)}`}>{selectedOrder.status || 'pending'}</span>
                <p className="order-progress-text">{selectedOrder.status === 'ready' ? 'Ready For Pickup' : getProgressLabel(selectedOrder)}</p>
                {selectedOrder.status === 'ready' && (
                  <label className="order-modal-status">
                    Finish Order
                    <select
                      value={selectedOrder.status}
                      disabled={updatingId === selectedOrder.id}
                      onChange={(event) => handleStatusChange(selectedOrder, event.target.value)}
                    >
                      {COMPLETABLE_STATUSES.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </label>
                )}
              </article>
            </div>

            <div className="ordered-products-list">
              <h3>Items requested</h3>
              {(selectedOrder.items || []).map((item, index) => (
                <div className="ordered-product-row" key={item.productId || `${selectedOrder.id}-${index}`}>
                  <div>
                    <p className="inventory-product-name">{productLabel(item) || 'Product'}</p>
                    <p className="orders-customer-meta">{buildProductKey(item)}</p>
                  </div>
                  <p>Qty {Number(item.quantity || 0)}</p>
                  <p>{formatCurrency(Number(item.price || 0) * Number(item.quantity || 0))}</p>
                </div>
              ))}
            </div>

            <div className="ordered-products-list">
              <h3>Locations assigned</h3>
              {(selectedOrder.assignedBoxes || []).length === 0 ? (
                <p className="orders-customer-meta">No locations assigned yet.</p>
              ) : (
                selectedOrder.assignedBoxes.map((box, index) => (
                  <div className="ordered-product-row order-box-row" key={`${box.commandId || box.locationId}-${index}`}>
                    <div>
                      <p className="inventory-product-name">{box.productKey}</p>
                      <p className="orders-customer-meta">Location {box.locationNumber || box.locationId}</p>
                    </div>
                    <p>{box.status || 'waiting'}</p>
                    <p>{box.commandId || '-'}</p>
                  </div>
                ))
              )}
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
