import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

const WAREHOUSE_GRID = [
  [9, 8, 7],
  [6, 5, 4],
  [3, 2, 1],
];

const SORTING_MODES = [
  { label: 'Brand', value: 'BRAND' },
  { label: 'Size', value: 'SIZE' },
  { label: 'Color', value: 'COLOR' },
  { label: 'Model', value: 'MODEL' },
  { label: 'Brand + Size', value: 'BRAND_SIZE' },
  { label: 'Color + Size', value: 'COLOR_SIZE' },
  { label: 'Model + Size', value: 'MODEL_SIZE' },
];

function createEmptyLocation(locationId, sortingMode = 'BRAND') {
  return {
    locationId,
    isOccupied: false,
    productId: '',
    brand: '',
    model: '',
    color: '',
    size: '',
    quantity: 0,
    sortingMode,
    assignedGroup: '',
    lastUpdated: null,
  };
}

function getLocationStatus(location) {
  if (!location?.isOccupied) return { label: 'Empty', className: 'location-empty' };
  if (Number(location.quantity || 0) <= 3) return { label: 'Low Stock', className: 'location-low' };
  return { label: 'Occupied', className: 'location-occupied' };
}

function getProductName(location) {
  const name = [location.brand, location.model, location.color, location.size ? `Size ${location.size}` : '']
    .filter(Boolean)
    .join(' ');
  return name || 'No product assigned';
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
  const [sortingMode, setSortingMode] = useState('BRAND');
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState('');
  const [selectedLocation, setSelectedLocation] = useState(null);

  const loadLocations = async () => {
    setLoading(true);
    setError('');

    try {
      const locationsQuery = query(collection(db, 'locations'), orderBy('locationId', 'asc'));
      const snapshot = await getDocs(locationsQuery);
      const items = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      setLocations(items);
      const firstMode = items.find((item) => item.sortingMode)?.sortingMode;
      if (firstMode) setSortingMode(firstMode);
    } catch {
      setError('Unable to load warehouse locations.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLocations();
  }, []);

  const locationsById = useMemo(() => {
    const map = new Map();
    locations.forEach((location) => {
      map.set(Number(location.locationId), location);
    });
    for (let id = 1; id <= 9; id += 1) {
      if (!map.has(id)) map.set(id, createEmptyLocation(id, sortingMode));
    }
    return map;
  }, [locations, sortingMode]);

  const summary = useMemo(() => {
    const currentLocations = Array.from(locationsById.values());
    return {
      total: 9,
      occupied: currentLocations.filter((location) => location.isOccupied).length,
      empty: currentLocations.filter((location) => !location.isOccupied).length,
      lowStock: currentLocations.filter((location) => location.isOccupied && Number(location.quantity || 0) <= 3).length,
    };
  }, [locationsById]);

  const handleSeedLocations = async () => {
    setSeeding(true);
    setError('');

    try {
      const writes = Array.from({ length: 9 }, (_, index) => {
        const locationId = index + 1;
        const locationRef = doc(db, 'locations', String(locationId));
        return setDoc(locationRef, {
          ...createEmptyLocation(locationId, sortingMode),
          lastUpdated: serverTimestamp(),
        }, { merge: true });
      });

      await Promise.all(writes);
      await loadLocations();
    } catch {
      setError('Unable to seed warehouse locations.');
    } finally {
      setSeeding(false);
    }
  };

  const handleSortingModeChange = (event) => {
    setSortingMode(event.target.value);
  };

  return (
    <div className="admin-locations-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Warehouse structure</p>
          <h1>Locations Management</h1>
          <p>Prepare the 9-location warehouse layer for future ESP, camera, dispenser, retrieval, and sorting systems.</p>
        </div>
        <button className="button button-primary" type="button" onClick={handleSeedLocations} disabled={seeding}>
          {seeding ? 'Seeding...' : 'Seed Locations'}
        </button>
      </section>

      <section className="inventory-summary-grid" aria-label="Warehouse summary">
        <article className="admin-summary-card">
          <p className="metric-label">Total Locations</p>
          <p className="metric-value">{summary.total}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Occupied</p>
          <p className="metric-value">{summary.occupied}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Empty</p>
          <p className="metric-value">{summary.empty}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Low Stock</p>
          <p className="metric-value">{summary.lowStock}</p>
          <p className="metric-note">Quantity less than or equal to 3.</p>
        </article>
      </section>

      <section className="admin-inventory-panel">
        <div className="locations-toolbar">
          <label className="warehouse-mode-selector">
            Sorting Mode
            <select value={sortingMode} onChange={handleSortingModeChange}>
              {SORTING_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
          </label>
          <div className="warehouse-command-preview" aria-label="Future ESP command examples">
            <p className="spec-label">Future command structure</p>
            <code>{'{ deviceId: "esp-main-01", command: "SITE 4", status: "pending" }'}</code>
            <code>{'{ deviceId: "esp-main-01", command: "SITE 7", status: "pending" }'}</code>
          </div>
        </div>

        {loading ? (
          <LoadingState message="Loading warehouse locations..." />
        ) : error ? (
          <EmptyState title="Locations unavailable" description={error} />
        ) : (
          <div className="warehouse-grid" aria-label="Warehouse layout grid">
            {WAREHOUSE_GRID.flat().map((locationId) => {
              const location = locationsById.get(locationId);
              const status = getLocationStatus(location);

              return (
                <button
                  key={locationId}
                  className={`warehouse-location-card ${status.className}`}
                  type="button"
                  onClick={() => setSelectedLocation(location)}
                >
                  <span className="warehouse-location-number">Location {locationId}</span>
                  <span className="status-badge">{status.label}</span>
                  <strong>{getProductName(location)}</strong>
                  <span>Quantity: {Number(location.quantity || 0)}</span>
                  <span>Group: {location.assignedGroup || 'Unassigned'}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selectedLocation && (
        <div className="order-modal-backdrop" onClick={() => setSelectedLocation(null)}>
          <section className="order-details-modal location-details-modal" onClick={(event) => event.stopPropagation()}>
            <div className="order-modal-header">
              <div>
                <p className="section-eyebrow">Location details</p>
                <h2>Location {selectedLocation.locationId}</h2>
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
                <p className="spec-label">Quantity</p>
                <p className="spec-value">{Number(selectedLocation.quantity || 0)}</p>
              </article>
              <article>
                <p className="spec-label">Occupied Status</p>
                <p className="spec-value">{selectedLocation.isOccupied ? 'Occupied' : 'Empty'}</p>
              </article>
              <article>
                <p className="spec-label">Sorting Mode</p>
                <p className="spec-value">{selectedLocation.sortingMode || sortingMode}</p>
              </article>
              <article>
                <p className="spec-label">Assigned Group</p>
                <p className="spec-value">{selectedLocation.assignedGroup || 'Unassigned'}</p>
              </article>
              <article className="location-detail-wide">
                <p className="spec-label">Last Updated</p>
                <p className="spec-value">{formatDate(selectedLocation.lastUpdated)}</p>
              </article>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default AdminLocations;
