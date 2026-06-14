import { useEffect, useMemo, useState } from 'react';
import { collection, deleteField, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';
import { clearLocationManual, markLocationFullManual, syncAllProductInventoryFromLocations } from '../../utils/inventorySync.js';
import { buildNormalizedSku } from '../../utils/productVisibility.js';

const WAREHOUSE_GRID = [
  [9, 8, 7],
  [6, 5, 4],
  [3, 2, 1],
];

const TOTAL_LOCATIONS = 9;
const TOTAL_MOVEMENT_POINTS = 18;

const DEFAULT_SYSTEM_SETTINGS = {
  sortingMode: 'brand',
  priority: ['brand'],
  totalLocations: TOTAL_LOCATIONS,
  totalPositions: TOTAL_MOVEMENT_POINTS,
  commandType: 'GO',
};

function createEmptyLocation(position) {
  return {
    status: 'empty',
    position,
    brand: '',
    model: '',
    color: '',
    size: '',
    updatedAt: null,
  };
}

function getLocationStatus(location) {
  if (location?.status === 'full' || location?.isOccupied) return { label: 'Full', className: 'location-occupied' };
  if (location?.status === 'reserved') return { label: 'Reserved', className: 'location-reserved' };
  return { label: 'Empty', className: 'location-empty' };
}

function getProductName(location) {
  const name = [location.brand, location.model, location.color, location.size ? `Size ${location.size}` : '']
    .filter(Boolean)
    .join(' ');
  return name || 'No product assigned';
}

function getProductTitle(product) {
  return product.name || [product.brand, product.model, product.color, product.size ? `Size ${product.size}` : '']
    .filter(Boolean)
    .join(' ') || product.id;
}

function isEmptyLocation(location) {
  return (
    String(location?.status || 'empty').toLowerCase() === 'empty' &&
    location?.reserved !== true &&
    location?.occupied !== true &&
    location?.isOccupied !== true
  );
}

function isFullLocation(location) {
  return String(location?.status || '').toLowerCase() === 'full' && (location?.occupied === true || location?.isOccupied === true);
}

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

function AdminLocations() {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetting, setResetting] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [products, setProducts] = useState([]);
  const [manualLocation, setManualLocation] = useState(null);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [manualError, setManualError] = useState('');
  const [manualSaving, setManualSaving] = useState(false);

  const initializeWarehouse = async () => {
    await setDoc(doc(db, 'settings', 'system'), DEFAULT_SYSTEM_SETTINGS, { merge: true });

    const writes = Array.from({ length: TOTAL_LOCATIONS }, async (_, index) => {
      const position = index + 1;
      const locationRef = doc(db, 'locations', String(position));
      const locationSnapshot = await getDoc(locationRef);

      if (!locationSnapshot.exists()) {
        return setDoc(locationRef, {
          ...createEmptyLocation(position),
          updatedAt: serverTimestamp(),
        });
      }

      const current = locationSnapshot.data();
      return setDoc(locationRef, {
        status: current.status || (current.isOccupied ? 'full' : 'empty'),
        position: current.position || position,
        brand: current.brand || '',
        model: current.model || '',
        color: current.color || '',
        size: current.size || '',
        updatedAt: current.updatedAt || current.lastUpdated || serverTimestamp(),
      }, { merge: true });
    });

    await Promise.all(writes);
  };

  const loadLocations = async () => {
    setLoading(true);
    setError('');

    try {
      await initializeWarehouse();
      const snapshot = await getDocs(collection(db, 'locations'));
      const items = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .sort((left, right) => Number(left.position || left.id) - Number(right.position || right.id));

      setLocations(items);
    } catch {
      setError('Unable to load warehouse locations.');
    } finally {
      setLoading(false);
    }
  };

  const loadProducts = async () => {
    try {
      const productsSnapshot = await getDocs(query(collection(db, 'products'), orderBy('createdAt', 'desc')));
      setProducts(productsSnapshot.docs.map((productDoc) => ({ id: productDoc.id, ...productDoc.data() })));
    } catch {
      setError('Unable to load products for manual location fill.');
    }
  };

  useEffect(() => {
    loadLocations();
    loadProducts();
  }, []);

  const openManualFill = (location) => {
    setManualLocation(location);
    setSelectedProductId('');
    setManualError('');
    setNotice('');
    console.info('[MANUAL_LOCATION_FILL_OPENED]', { locationId: location.position || location.id });
  };

  const handleManualFill = async (event) => {
    event.preventDefault();
    if (!manualLocation) return;

    const product = products.find((item) => item.id === selectedProductId);
    if (!product) {
      setManualError('Select a product first.');
      return;
    }

    setManualSaving(true);
    setManualError('');
    setNotice('');

    try {
      await markLocationFullManual(manualLocation.position || manualLocation.id, product);
      setNotice(`Location ${manualLocation.position || manualLocation.id} filled manually.`);
      setManualLocation(null);
      setSelectedProductId('');
      await loadLocations();
    } catch (manualFillError) {
      setManualError(manualFillError.message || 'Unable to fill this location manually.');
    } finally {
      setManualSaving(false);
    }
  };

  const handleManualClear = async (location) => {
    if (!window.confirm(`Clear location ${location.position || location.id}?`)) return;

    setManualSaving(true);
    setError('');
    setNotice('');

    try {
      await clearLocationManual(location.position || location.id);
      setNotice(`Location ${location.position || location.id} cleared.`);
      setSelectedLocation(null);
      await loadLocations();
    } catch (clearError) {
      setError(clearError.message || 'Unable to clear this location.');
    } finally {
      setManualSaving(false);
    }
  };

  const resetAllLocations = async () => {
    if (!window.confirm('Reset all warehouse locations?')) return;

    setResetting(true);
    setError('');

    try {
      const batch = writeBatch(db);
      for (let position = 1; position <= TOTAL_LOCATIONS; position += 1) {
        batch.set(doc(db, 'locations', String(position)), {
          status: 'empty',
          reserved: false,
          occupied: false,
          isOccupied: false,
          position,
          locationId: position,
          productKey: deleteField(),
          productId: deleteField(),
          sku: deleteField(),
          normalizedSku: deleteField(),
          brand: deleteField(),
          model: deleteField(),
          color: deleteField(),
          size: deleteField(),
          scanId: deleteField(),
          reservedAt: deleteField(),
          filledAt: deleteField(),
          filledBy: deleteField(),
          reservedForOrder: deleteField(),
          reservedForOrderId: deleteField(),
          reservedOrderItemKey: deleteField(),
          reservedBy: deleteField(),
          assignmentStatus: deleteField(),
          selectedLocation: deleteField(),
          inPosition: deleteField(),
          outPosition: deleteField(),
          commandId: deleteField(),
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit();
      await syncAllProductInventoryFromLocations();
      setSelectedLocation(null);
      await loadLocations();
    } catch {
      setError('Unable to reset warehouse locations.');
    } finally {
      setResetting(false);
    }
  };

  const locationsById = useMemo(() => {
    const map = new Map();
    locations.forEach((location) => {
      map.set(Number(location.position || location.id), location);
    });
    for (let id = 1; id <= TOTAL_LOCATIONS; id += 1) {
      if (!map.has(id)) map.set(id, createEmptyLocation(id));
    }
    return map;
  }, [locations]);

  const summary = useMemo(() => {
    const currentLocations = Array.from(locationsById.values());
    return {
      total: TOTAL_LOCATIONS,
      full: currentLocations.filter((location) => location.status === 'full' || location.isOccupied).length,
      reserved: currentLocations.filter((location) => location.status === 'reserved').length,
      empty: currentLocations.filter((location) => !['full', 'reserved'].includes(location.status) && !location.isOccupied).length,
    };
  }, [locationsById]);

  return (
    <div className="admin-locations-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Warehouse structure</p>
          <h1>Positions Management</h1>
          <p>Prepare the 9 physical warehouse locations for GO movement commands.</p>
        </div>
      </section>

      <section className="inventory-summary-grid" aria-label="Warehouse summary">
        <article className="admin-summary-card">
          <p className="metric-label">Total Positions</p>
          <p className="metric-value">{summary.total}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Full</p>
          <p className="metric-value">{summary.full}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Reserved</p>
          <p className="metric-value">{summary.reserved}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Empty</p>
          <p className="metric-value">{summary.empty}</p>
        </article>
      </section>

      <section className="admin-inventory-panel">
        <div className="locations-toolbar">
          <div className="warehouse-command-preview" aria-label="Future ESP command examples">
            <p className="spec-label">Future command structure</p>
            <code>{'Location 1: IN GO 1 / OUT GO 2'}</code>
            <code>{'Location 9: IN GO 17 / OUT GO 18'}</code>
          </div>
          <button className="button button-danger" type="button" onClick={resetAllLocations} disabled={loading || resetting}>
            {resetting ? 'Resetting...' : 'Reset All Locations'}
          </button>
        </div>

        {loading ? (
          <LoadingState message="Loading warehouse locations..." />
        ) : (
          <>
            {error && <p className="admin-form-error">{error}</p>}
            {notice && <p className="admin-form-success">{notice}</p>}
            <div className="warehouse-grid" aria-label="Warehouse layout grid">
              {WAREHOUSE_GRID.flat().map((position) => {
                const location = locationsById.get(position);
                const status = getLocationStatus(location);
                const empty = isEmptyLocation(location);
                const full = isFullLocation(location);

                return (
                  <article
                    key={position}
                    className={`warehouse-location-card ${status.className}`}
                  >
                    <button
                      className="warehouse-location-main"
                      type="button"
                      onClick={() => setSelectedLocation(location)}
                    >
                      <span className="warehouse-location-number">Position {position}</span>
                      <span className="status-badge">{status.label}</span>
                      <strong>{getProductName(location)}</strong>
                      <span>Status: {location.status || 'empty'}</span>
                      <span>SKU: {location.normalizedSku || location.sku || '-'}</span>
                      <span>Filled by: {location.filledBy || (location.scanId || location.commandId ? 'automation' : '-')}</span>
                    </button>

                    <div className="warehouse-location-actions">
                      {empty && (
                        <button className="button button-secondary" type="button" onClick={() => openManualFill(location)}>
                          Manual Fill
                        </button>
                      )}
                      {full && (
                        <button className="button button-danger" type="button" onClick={() => handleManualClear(location)} disabled={manualSaving}>
                          Clear Location
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>

      {selectedLocation && (
        <div className="order-modal-backdrop" onClick={() => setSelectedLocation(null)}>
          <section className="order-details-modal location-details-modal" onClick={(event) => event.stopPropagation()}>
            <div className="order-modal-header">
              <div>
                <p className="section-eyebrow">Position details</p>
                <h2>Position {selectedLocation.position}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setSelectedLocation(null)} aria-label="Close location details">
                Close
              </button>
            </div>

            <div className="location-details-grid">
              <article>
                <p className="spec-label">Brand</p>
                <p className="spec-value">{selectedLocation.brand || '-'}</p>
              </article>
              <article>
                <p className="spec-label">Model</p>
                <p className="spec-value">{selectedLocation.model || '-'}</p>
              </article>
              <article>
                <p className="spec-label">Color</p>
                <p className="spec-value">{selectedLocation.color || '-'}</p>
              </article>
              <article>
                <p className="spec-label">Size</p>
                <p className="spec-value">{selectedLocation.size || '-'}</p>
              </article>
              <article>
                <p className="spec-label">Status</p>
                <p className="spec-value">{selectedLocation.status || 'empty'}</p>
              </article>
              <article>
                <p className="spec-label">SKU</p>
                <p className="spec-value">{selectedLocation.normalizedSku || selectedLocation.sku || '-'}</p>
              </article>
              <article>
                <p className="spec-label">Filled By</p>
                <p className="spec-value">{selectedLocation.filledBy || (selectedLocation.scanId || selectedLocation.commandId ? 'automation' : '-')}</p>
              </article>
              <article className="location-detail-wide">
                <p className="spec-label">Last Updated</p>
                <p className="spec-value">{formatDate(selectedLocation.updatedAt || selectedLocation.lastUpdated)}</p>
              </article>
            </div>
          </section>
        </div>
      )}

      {manualLocation && (
        <div className="order-modal-backdrop" onClick={() => setManualLocation(null)}>
          <section className="order-details-modal location-details-modal" onClick={(event) => event.stopPropagation()}>
            <div className="order-modal-header">
              <div>
                <p className="section-eyebrow">Manual warehouse fill</p>
                <h2>Manual Fill Position {manualLocation.position || manualLocation.id}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setManualLocation(null)} aria-label="Close manual fill">
                Close
              </button>
            </div>

            <form className="manual-location-form" onSubmit={handleManualFill}>
              {manualError && <p className="admin-form-error">{manualError}</p>}

              <label>
                Existing product
                <select value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)}>
                  <option value="">Select a product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {getProductTitle(product)} / {product.normalizedSku || product.sku || buildNormalizedSku(product)}
                    </option>
                  ))}
                </select>
              </label>

              {selectedProductId && (() => {
                const product = products.find((item) => item.id === selectedProductId);
                if (!product) return null;
                const sku = product.normalizedSku || product.sku || buildNormalizedSku(product);
                return (
                  <div className="location-details-grid manual-product-preview">
                    <article>
                      <p className="spec-label">Brand</p>
                      <p className="spec-value">{product.brand || '-'}</p>
                    </article>
                    <article>
                      <p className="spec-label">Model</p>
                      <p className="spec-value">{product.model || product.name || '-'}</p>
                    </article>
                    <article>
                      <p className="spec-label">Color</p>
                      <p className="spec-value">{product.color || '-'}</p>
                    </article>
                    <article>
                      <p className="spec-label">Size</p>
                      <p className="spec-value">{product.size || '-'}</p>
                    </article>
                    <article className="location-detail-wide">
                      <p className="spec-label">SKU</p>
                      <p className="spec-value">{sku}</p>
                    </article>
                  </div>
                );
              })()}

              <div className="checkout-actions">
                <button className="button button-secondary" type="button" onClick={() => setManualLocation(null)}>
                  Cancel
                </button>
                <button className="button button-primary" type="submit" disabled={manualSaving || !selectedProductId}>
                  {manualSaving ? 'Filling...' : 'Add Product Manually'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default AdminLocations;
