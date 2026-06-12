import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { db } from '../../firebase/firebase.js';

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
  const [selectedLocation, setSelectedLocation] = useState(null);

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

  useEffect(() => {
    loadLocations();
  }, []);

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
        </div>

        {loading ? (
          <LoadingState message="Loading warehouse locations..." />
        ) : error ? (
          <EmptyState title="Locations unavailable" description={error} />
        ) : (
          <div className="warehouse-grid" aria-label="Warehouse layout grid">
            {WAREHOUSE_GRID.flat().map((position) => {
              const location = locationsById.get(position);
              const status = getLocationStatus(location);

              return (
                <button
                  key={position}
                  className={`warehouse-location-card ${status.className}`}
                  type="button"
                  onClick={() => setSelectedLocation(location)}
                >
                  <span className="warehouse-location-number">Position {position}</span>
                  <span className="status-badge">{status.label}</span>
                  <strong>{getProductName(location)}</strong>
                  <span>Status: {location.status || 'empty'}</span>
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
              <article className="location-detail-wide">
                <p className="spec-label">Last Updated</p>
                <p className="spec-value">{formatDate(selectedLocation.updatedAt || selectedLocation.lastUpdated)}</p>
              </article>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default AdminLocations;
