import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase/firebase.js';

export const VALID_SORTING_STRATEGIES = new Set([
  'brand',
  'size',
  'color',
  'model',
  'brand_size',
  'color_size',
  'model_size',
]);

const ESP_DEVICE_ID = 'esp-main-01';
const TOTAL_LOCATIONS = 9;

const NEIGHBORS = {
  1: [2, 4],
  2: [1, 3, 5],
  3: [2, 6],
  4: [1, 5, 7],
  5: [2, 4, 6, 8],
  6: [3, 5, 9],
  7: [4, 8],
  8: [5, 7, 9],
  9: [6, 8],
};

const STRATEGY_WEIGHTS = {
  brand: { brand: 10 },
  model: { model: 10 },
  color: { color: 10 },
  size: { size: 10 },
  brand_size: { brand: 10, size: 7 },
  color_size: { color: 10, size: 7 },
  model_size: { model: 10, size: 7 },
};

const ACTIVE_SCAN_STATUSES = new Set(['CONFIRMED']);
const FINAL_SCAN_STATUSES = new Set(['ASSIGNED', 'PROCESSING', 'COMMAND_CREATED', 'STORED', 'DONE', 'ERROR']);

function normalize(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSku(scan) {
  return String(scan.normalizedSku || [scan.brand, scan.model, scan.color, scan.size]
    .map((part) => String(part || '').trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean)
    .join('_'));
}

function productKeyFor(scan) {
  return scan.productKey || [scan.brand, scan.model, scan.color, scan.size].map(normalize).join('|');
}

function safeDocId(value) {
  return String(value || '').replaceAll('/', '_').trim() || crypto.randomUUID();
}

function locationIdOf(location, fallbackId) {
  const id = Number(location.locationId || location.position || fallbackId);
  return Number.isInteger(id) ? id : fallbackId;
}

function isEmptyLocation(location, fallbackId) {
  const id = locationIdOf(location, fallbackId);
  const status = String(location.status || '').trim().toLowerCase();
  if (!Number.isInteger(id) || id < 1 || id > TOTAL_LOCATIONS) return false;
  if (status === 'reserved' || status === 'full') return false;
  return status === 'empty' || !location.isOccupied;
}

function scoreNeighbor(scan, neighbor, strategy) {
  const weights = STRATEGY_WEIGHTS[strategy] || {};
  return Object.entries(weights).reduce((score, [field, weight]) => {
    return normalize(scan[field]) && normalize(scan[field]) === normalize(neighbor[field]) ? score + weight : score;
  }, 0);
}

function scoreLocation(scan, locationsById, locationId, strategy) {
  return (NEIGHBORS[locationId] || []).reduce((score, neighborId) => {
    return score + scoreNeighbor(scan, locationsById.get(neighborId) || {}, strategy);
  }, 0);
}

function chooseStorageLocation(scan, locations, strategy) {
  const locationsById = new Map();
  for (let id = 1; id <= TOTAL_LOCATIONS; id += 1) {
    locationsById.set(id, { status: 'empty', position: id });
  }
  locations.forEach((location, index) => {
    const fallbackId = index + 1;
    locationsById.set(locationIdOf(location, fallbackId), location);
  });

  const emptyLocations = Array.from({ length: TOTAL_LOCATIONS }, (_, index) => index + 1)
    .filter((locationId) => isEmptyLocation(locationsById.get(locationId), locationId));

  if (emptyLocations.length === 0) return null;

  const ranked = emptyLocations
    .map((locationId) => ({
      locationId,
      score: scoreLocation(scan, locationsById, locationId, strategy),
    }))
    .sort((left, right) => right.score - left.score || left.locationId - right.locationId);

  return ranked[0].score > 0 ? ranked[0].locationId : emptyLocations[0];
}

function locationPositions(locationId) {
  return {
    inPosition: locationId * 2 - 1,
    outPosition: locationId * 2,
  };
}

function scanPayload(scan) {
  return {
    brand: normalize(scan.brand),
    model: normalize(scan.model),
    color: normalize(scan.color),
    size: normalize(scan.size),
    productKey: productKeyFor(scan),
    normalizedSku: normalizeSku(scan),
  };
}

export async function assignConfirmedScan(scanDocId) {
  const scanRef = doc(db, 'scanQueue', scanDocId);
  const settingsRef = doc(db, 'settings', 'system');
  const commandRef = doc(db, 'commands', `scan-${safeDocId(scanDocId)}`);
  const locationRefs = Array.from({ length: TOTAL_LOCATIONS }, (_, index) => doc(db, 'locations', String(index + 1)));

  return runTransaction(db, async (transaction) => {
    const scanSnapshot = await transaction.get(scanRef);
    const settingsSnapshot = await transaction.get(settingsRef);
    const commandSnapshot = await transaction.get(commandRef);
    const locationSnapshots = await Promise.all(locationRefs.map((locationRef) => transaction.get(locationRef)));

    if (!scanSnapshot.exists()) {
      return { skipped: true, reason: 'duplicate scan' };
    }

    const scan = scanSnapshot.data();
    const status = String(scan.status || '').toUpperCase();
    if (!ACTIVE_SCAN_STATUSES.has(status)) {
      return { skipped: true, reason: FINAL_SCAN_STATUSES.has(status) ? 'already processed' : `unsupported status ${status}` };
    }

    if (commandSnapshot.exists()) {
      transaction.set(scanRef, {
        status: 'ASSIGNED',
        assignmentStatus: 'COMMAND_CREATED',
        commandId: commandRef.id,
        duplicateGuard: 'existing-command',
        updatedAt: serverTimestamp(),
      }, { merge: true });
      return { skipped: true, reason: 'duplicate scan', commandId: commandRef.id };
    }

    const sortingMode = String(settingsSnapshot.data()?.sortingMode || '').trim();
    if (!VALID_SORTING_STRATEGIES.has(sortingMode)) {
      transaction.set(scanRef, {
        status: 'ERROR',
        errorCode: 'missing-sortingMode',
        errorMessage: 'Missing or invalid settings/system.sortingMode.',
        updatedAt: serverTimestamp(),
      }, { merge: true });
      return { skipped: true, reason: 'missing sortingMode' };
    }

    const locations = locationSnapshots.map((snapshot, index) => ({
      id: snapshot.id,
      position: index + 1,
      ...(snapshot.exists() ? snapshot.data() : {}),
    }));
    const selectedLocation = chooseStorageLocation(scan, locations, sortingMode);
    if (!selectedLocation) {
      transaction.set(scanRef, {
        status: 'ERROR',
        errorCode: 'no-empty-locations',
        errorMessage: 'No empty warehouse location is available.',
        updatedAt: serverTimestamp(),
      }, { merge: true });
      return { skipped: true, reason: 'no empty locations' };
    }

    const commandId = commandRef.id;
    const { inPosition, outPosition } = locationPositions(selectedLocation);
    const payload = {
      operation: 'put',
      scanId: scan.scanId || scanDocId,
      locationId: selectedLocation,
      inPosition,
      outPosition,
      ...scanPayload(scan),
    };

    transaction.set(scanRef, {
      status: 'ASSIGNED',
      assignmentStatus: 'COMMAND_CREATED',
      selectedLocation,
      locationId: selectedLocation,
      inPosition,
      outPosition,
      commandId,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    transaction.set(doc(db, 'locations', String(selectedLocation)), {
      status: 'reserved',
      isOccupied: false,
      locationId: selectedLocation,
      position: selectedLocation,
      productId: payload.normalizedSku,
      normalizedSku: payload.normalizedSku,
      productKey: payload.productKey,
      brand: payload.brand,
      model: payload.model,
      color: payload.color,
      size: payload.size,
      scanId: payload.scanId,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    transaction.set(commandRef, {
      commandId,
      deviceId: ESP_DEVICE_ID,
      command: 'GO',
      arduinoCommand: `GO ${inPosition}`,
      type: 'GO',
      position: inPosition,
      status: 'pending',
      source: 'website-scan-processor',
      scanId: payload.scanId,
      locationId: selectedLocation,
      payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Inventory stock is intentionally not incremented here.
    // Status plan: CONFIRMED -> ASSIGNED -> COMMAND_CREATED -> STORED/DONE after storage completion.
    return {
      skipped: false,
      scanId: payload.scanId,
      commandId,
      locationId: selectedLocation,
      inPosition,
    };
  });
}
