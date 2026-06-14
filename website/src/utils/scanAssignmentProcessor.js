import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { db } from '../firebase/firebase.js';
import { markLocationReserved, recomputeProductInventoryFromLocations } from './inventorySync.js';

export const VALID_SORTING_STRATEGIES = new Set([
  'brand',
  'size',
  'color',
  'model',
  'brand_size',
  'color_size',
  'model_size',
  'sku_exact',
  'smart_auto',
  'nearest_location_priority',
]);

const ESP_DEVICE_ID = 'esp-main-01';
const TOTAL_LOCATIONS = 9;
const SORT_PATH = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const PRIORITY_ORDER = [1, 2, 4, 3, 5, 7, 6, 8, 9];
const BELT_MOVE_COMMAND = 'BELT_RUN_UNTIL_IR_LAST';
const PROCESSABLE_STATUS = 'CONFIRMED';
const PROCESSED_STATUSES = new Set(['ASSIGNED', 'COMMAND_CREATED', 'PROCESSING', 'STORED', 'DONE', 'ERROR']);

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

function normalize(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeStatus(value) {
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

function scanIdentity(scan, fallbackId) {
  return {
    scanId: String(scan.scanId || fallbackId),
    productKey: productKeyFor(scan),
    brand: normalize(scan.brand),
    model: normalize(scan.model),
    color: normalize(scan.color),
    size: normalize(scan.size),
    normalizedSku: normalizeSku(scan),
  };
}

function locationIdOf(location, fallbackId) {
  const id = Number(location.locationId || location.position || fallbackId);
  return Number.isInteger(id) ? id : fallbackId;
}

function isRejectedByOccupiedFlag(location) {
  return location?.occupied === true || location?.isOccupied === true;
}

function isEmptyLocation(location, fallbackId) {
  const id = locationIdOf(location, fallbackId);
  const status = String(location.status || '').trim().toLowerCase();
  if (!Number.isInteger(id) || id < 1 || id > TOTAL_LOCATIONS) return false;
  if (status === 'reserved' || status === 'full') return false;
  return (status === '' || status === 'empty') && !isRejectedByOccupiedFlag(location) && location?.reserved !== true;
}

function isFullLocation(location) {
  return (
    String(location?.status || '').trim().toLowerCase() === 'full' &&
    (location?.occupied === true || location?.isOccupied === true)
  );
}

function getSortPath() {
  return SORT_PATH;
}

function getLocationIndex(locationNumber) {
  return getSortPath().indexOf(Number(locationNumber));
}

function getEmptyCandidateLocations(locations) {
  return getSortPath().filter((locationId) => isEmptyLocation(locations.get(locationId), locationId));
}

function assignNearestLocationPriority(locations) {
  const emptyLocations = PRIORITY_ORDER.filter((locationId) => isEmptyLocation(locations.get(locationId), locationId));
  const rejectedLocations = PRIORITY_ORDER.filter((locationId) => !emptyLocations.includes(locationId));
  const scores = emptyLocations.map((locationId, index) => ({
    locationId,
    score: PRIORITY_ORDER.length - index,
    details: {
      candidate: locationId,
      priorityIndex: index,
      priorityOrder: PRIORITY_ORDER,
      reason: 'first-empty-location-in-priority-order',
      finalScore: PRIORITY_ORDER.length - index,
    },
  }));

  return {
    emptyLocations,
    scores,
    selectedLocation: emptyLocations[0] || null,
    requestedStrategy: 'nearest_location_priority',
    resolvedStrategy: 'nearest_location_priority',
    rejectedLocations,
    tieBreakUsed: false,
  };
}

function getFullLocations(locations) {
  return getSortPath()
    .map((locationId) => ({ locationId, ...(locations.get(locationId) || {}) }))
    .filter(isFullLocation);
}

function getAdjacentLocations(locationNumber) {
  const path = getSortPath();
  const index = getLocationIndex(locationNumber);
  const logicalNeighbors = [
    index > 0 ? path[index - 1] : null,
    index >= 0 && index < path.length - 1 ? path[index + 1] : null,
  ].filter(Boolean);
  return Array.from(new Set([...(NEIGHBORS[locationNumber] || []), ...logicalNeighbors]));
}

function getNearestFullBefore(candidate, fullLocations) {
  const candidateIndex = getLocationIndex(candidate);
  return fullLocations
    .filter((location) => getLocationIndex(location.locationId) < candidateIndex)
    .sort((left, right) => getLocationIndex(right.locationId) - getLocationIndex(left.locationId))[0] || null;
}

function getNearestFullAfter(candidate, fullLocations) {
  const candidateIndex = getLocationIndex(candidate);
  return fullLocations
    .filter((location) => getLocationIndex(location.locationId) > candidateIndex)
    .sort((left, right) => getLocationIndex(left.locationId) - getLocationIndex(right.locationId))[0] || null;
}

function sizeNumber(value) {
  const parsed = Number.parseFloat(String(value || '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldMatches(product, location, field) {
  if (field === 'normalizedSku' || field === 'sku') {
    return normalize(product.normalizedSku || product.sku) && normalize(product.normalizedSku || product.sku) === normalize(location.normalizedSku || location.sku);
  }
  return normalize(product[field]) && normalize(product[field]) === normalize(location[field]);
}

function distanceInSortPath(left, right) {
  return Math.abs(getLocationIndex(left) - getLocationIndex(right));
}

function nearestDistanceToLocations(candidate, locations) {
  if (locations.length === 0) return TOTAL_LOCATIONS;
  return Math.min(...locations.map((location) => distanceInSortPath(candidate, location.locationId)));
}

function centerDistance(locationId) {
  return Math.abs(getLocationIndex(locationId) - getLocationIndex(5));
}

function scoreSizeOrder(candidate, product, locations) {
  const fullLocations = Array.isArray(locations) ? locations : getFullLocations(locations);
  const newSize = sizeNumber(product.size);
  const details = {
    candidate,
    newSize,
    previousFull: null,
    nextFull: null,
    sameSizeDistance: null,
    orderPenalty: 0,
    score: 0,
  };

  if (newSize === null) {
    details.orderPenalty = -20;
    details.score = -20;
    return { score: details.score, details };
  }

  const previous = getNearestFullBefore(candidate, fullLocations);
  const next = getNearestFullAfter(candidate, fullLocations);
  const previousSize = previous ? sizeNumber(previous.size) : null;
  const nextSize = next ? sizeNumber(next.size) : null;
  let score = 0;

  details.previousFull = previous ? { locationId: previous.locationId, size: previousSize } : null;
  details.nextFull = next ? { locationId: next.locationId, size: nextSize } : null;

  if (previousSize === null) score += 18;
  else if (previousSize <= newSize) score += 40 - Math.min(16, Math.abs(newSize - previousSize) * 2);
  else {
    const penalty = 90 + Math.min(60, Math.abs(previousSize - newSize) * 5);
    details.orderPenalty += penalty;
    score -= penalty;
  }

  if (nextSize === null) score += 18;
  else if (nextSize >= newSize) score += 40 - Math.min(16, Math.abs(nextSize - newSize) * 2);
  else {
    const penalty = 90 + Math.min(60, Math.abs(newSize - nextSize) * 5);
    details.orderPenalty += penalty;
    score -= penalty;
  }

  const sameSizeLocations = fullLocations.filter((location) => sizeNumber(location.size) === newSize);
  if (sameSizeLocations.length > 0) {
    const distance = nearestDistanceToLocations(candidate, sameSizeLocations);
    const adjacentSameSize = getAdjacentLocations(candidate).some((locationId) => sameSizeLocations.some((location) => location.locationId === locationId));
    details.sameSizeDistance = distance;
    score += Math.max(0, 120 - distance * 18);
    if (adjacentSameSize) score += 130;
  }

  details.score = score;
  return { score, details };
}

function scoreCluster(candidate, product, locations, field) {
  const fullLocations = Array.isArray(locations) ? locations : getFullLocations(locations);
  const matchingLocations = fullLocations.filter((location) => fieldMatches(product, location, field));
  const details = {
    candidate,
    field,
    matchingLocations: matchingLocations.map((location) => location.locationId),
    adjacentMatches: [],
    nearestDistance: null,
    score: 0,
  };

  if (matchingLocations.length === 0) return { score: 0, details };

  const adjacentMatches = getAdjacentLocations(candidate).filter((locationId) => matchingLocations.some((location) => location.locationId === locationId));
  const nearestDistance = nearestDistanceToLocations(candidate, matchingLocations);
  let score = Math.max(0, 90 - nearestDistance * 14);

  if (adjacentMatches.length > 0) score += 130 + adjacentMatches.length * 20;

  details.adjacentMatches = adjacentMatches;
  details.nearestDistance = nearestDistance;
  details.score = score;
  return { score, details };
}

function resolveSortingStrategy(product, fullLocations, strategy) {
  if (strategy !== 'smart_auto') return strategy;
  if (fullLocations.some((location) => fieldMatches(product, location, 'normalizedSku'))) return 'sku_exact';
  if (fullLocations.some((location) => fieldMatches(product, location, 'model'))) return 'model_size';
  if (fullLocations.some((location) => fieldMatches(product, location, 'brand'))) return 'brand_size';
  if (fullLocations.some((location) => fieldMatches(product, location, 'color'))) return 'color_size';
  return 'size';
}

function balancedEmptyScore(candidate, emptyCandidates) {
  const centerScore = Math.max(0, 20 - centerDistance(candidate) * 4);
  const spacingScore = emptyCandidates.length > 1 ? Math.max(0, 8 - Math.abs(getLocationIndex(candidate) - ((TOTAL_LOCATIONS - 1) / 2))) : 0;
  return centerScore + spacingScore;
}

function scoreCandidate(candidate, product, locations, strategy, resolvedStrategy, emptyCandidates) {
  const fullLocations = getFullLocations(locations);
  const sizeScore = scoreSizeOrder(candidate, product, fullLocations);
  const brandScore = scoreCluster(candidate, product, fullLocations, 'brand');
  const modelScore = scoreCluster(candidate, product, fullLocations, 'model');
  const colorScore = scoreCluster(candidate, product, fullLocations, 'color');
  const skuScore = scoreCluster(candidate, product, fullLocations, 'normalizedSku');
  let score = balancedEmptyScore(candidate, emptyCandidates);
  const details = {
    candidate,
    requestedStrategy: strategy,
    resolvedStrategy,
    balancedScore: score,
    size: sizeScore.details,
    brand: brandScore.details,
    model: modelScore.details,
    color: colorScore.details,
    sku: skuScore.details,
    matchingClusterAdjacency: 0,
  };

  if (resolvedStrategy === 'size') {
    score += sizeScore.score;
    details.matchingClusterAdjacency = sizeScore.details.sameSizeDistance === 1 ? 1 : 0;
  } else if (resolvedStrategy === 'brand') {
    score += brandScore.score * 1.2;
    details.matchingClusterAdjacency = brandScore.details.adjacentMatches.length;
  } else if (resolvedStrategy === 'model') {
    score += modelScore.score * 1.45 + brandScore.score * 0.25;
    details.matchingClusterAdjacency = modelScore.details.adjacentMatches.length;
  } else if (resolvedStrategy === 'color') {
    score += colorScore.score * 1.25 + (fieldMatches(product, fullLocations.find((location) => colorScore.details.adjacentMatches.includes(location.locationId)) || {}, 'brand') ? 20 : 0);
    details.matchingClusterAdjacency = colorScore.details.adjacentMatches.length;
  } else if (resolvedStrategy === 'brand_size') {
    const sameBrandLocations = fullLocations.filter((location) => fieldMatches(product, location, 'brand'));
    const scopedSizeScore = scoreSizeOrder(candidate, product, sameBrandLocations.length ? sameBrandLocations : fullLocations);
    score += brandScore.score * 1.35 + scopedSizeScore.score * 0.85;
    if (sameBrandLocations.length > 0 && brandScore.score === 0) score -= 70;
    if (sameBrandLocations.some((location) => sizeNumber(location.size) === sizeNumber(product.size)) && getAdjacentLocations(candidate).some((locationId) => sameBrandLocations.some((location) => location.locationId === locationId && sizeNumber(location.size) === sizeNumber(product.size)))) {
      score += 120;
    }
    details.size = scopedSizeScore.details;
    details.matchingClusterAdjacency = brandScore.details.adjacentMatches.length;
  } else if (resolvedStrategy === 'color_size') {
    const sameColorLocations = fullLocations.filter((location) => fieldMatches(product, location, 'color'));
    const scopedSizeScore = scoreSizeOrder(candidate, product, sameColorLocations.length ? sameColorLocations : fullLocations);
    score += colorScore.score * 1.35 + scopedSizeScore.score * 0.85;
    if (sameColorLocations.length > 0 && colorScore.score === 0) score -= 70;
    if (sameColorLocations.some((location) => sizeNumber(location.size) === sizeNumber(product.size)) && getAdjacentLocations(candidate).some((locationId) => sameColorLocations.some((location) => location.locationId === locationId && sizeNumber(location.size) === sizeNumber(product.size)))) {
      score += 120;
    }
    details.size = scopedSizeScore.details;
    details.matchingClusterAdjacency = colorScore.details.adjacentMatches.length;
  } else if (resolvedStrategy === 'model_size') {
    const sameModelLocations = fullLocations.filter((location) => fieldMatches(product, location, 'model'));
    const scopedSizeScore = scoreSizeOrder(candidate, product, sameModelLocations.length ? sameModelLocations : fullLocations);
    score += modelScore.score * 1.55 + brandScore.score * 0.3 + scopedSizeScore.score * 0.9;
    if (sameModelLocations.length > 0 && modelScore.score === 0) score -= 80;
    if (sameModelLocations.some((location) => sizeNumber(location.size) === sizeNumber(product.size)) && getAdjacentLocations(candidate).some((locationId) => sameModelLocations.some((location) => location.locationId === locationId && sizeNumber(location.size) === sizeNumber(product.size)))) {
      score += 150;
    }
    details.size = scopedSizeScore.details;
    details.matchingClusterAdjacency = modelScore.details.adjacentMatches.length;
  } else if (resolvedStrategy === 'sku_exact') {
    const sameSkuLocations = fullLocations.filter((location) => fieldMatches(product, location, 'normalizedSku'));
    if (sameSkuLocations.length > 0) {
      score += skuScore.score * 2.2;
      if (skuScore.details.adjacentMatches.length > 0) score += 180;
      details.matchingClusterAdjacency = skuScore.details.adjacentMatches.length;
    } else {
      const fallback = scoreCandidate(candidate, product, locations, strategy, 'model_size', emptyCandidates);
      score += fallback.score;
      details.fallback = fallback.details;
      details.matchingClusterAdjacency = fallback.details.matchingClusterAdjacency;
    }
  }

  details.finalScore = score;
  return { locationId: candidate, score, details };
}

function chooseBestLocation(product, locations, strategy) {
  const emptyCandidates = getEmptyCandidateLocations(locations);
  const fullLocations = getFullLocations(locations);
  const resolvedStrategy = resolveSortingStrategy(product, fullLocations, strategy);
  const rejectedLocations = getSortPath()
    .filter((locationId) => !emptyCandidates.includes(locationId) && !isFullLocation(locations.get(locationId)));
  const scores = emptyCandidates
    .map((candidate) => scoreCandidate(candidate, product, locations, strategy, resolvedStrategy, emptyCandidates));

  const sortedScores = [...scores].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if ((right.details.matchingClusterAdjacency || 0) !== (left.details.matchingClusterAdjacency || 0)) {
      return (right.details.matchingClusterAdjacency || 0) - (left.details.matchingClusterAdjacency || 0);
    }
    if (centerDistance(left.locationId) !== centerDistance(right.locationId)) return centerDistance(left.locationId) - centerDistance(right.locationId);
    if (getLocationIndex(left.locationId) !== getLocationIndex(right.locationId)) return getLocationIndex(left.locationId) - getLocationIndex(right.locationId);
    return left.locationId - right.locationId;
  });

  const tieBreakUsed = sortedScores.length > 1 && sortedScores[0]?.score === sortedScores[1]?.score;
  return {
    emptyLocations: emptyCandidates,
    scores: sortedScores,
    selectedLocation: sortedScores[0]?.locationId || null,
    requestedStrategy: strategy,
    resolvedStrategy,
    rejectedLocations,
    tieBreakUsed,
  };
}

function buildLocationContext(locationSnapshots) {
  const locationsById = new Map();
  for (let id = 1; id <= TOTAL_LOCATIONS; id += 1) {
    locationsById.set(id, { status: '', position: id });
  }

  locationSnapshots.forEach((snapshot, index) => {
    locationsById.set(index + 1, {
      id: snapshot.id,
      position: index + 1,
      ...(snapshot.exists() ? snapshot.data() : {}),
    });
  });

  const emptyLocations = Array.from({ length: TOTAL_LOCATIONS }, (_, index) => index + 1)
    .filter((locationId) => isEmptyLocation(locationsById.get(locationId), locationId));

  return { locationsById, emptyLocations };
}

function chooseStorageLocation(scan, locationSnapshots, sortingMode) {
  const { locationsById } = buildLocationContext(locationSnapshots);
  if (sortingMode === 'nearest_location_priority') {
    return assignNearestLocationPriority(locationsById);
  }
  return chooseBestLocation(scan, locationsById, sortingMode);
}

function locationPositions(locationId) {
  return {
    inPosition: locationId * 2 - 1,
    outPosition: locationId * 2,
  };
}

function commandDocId(prefix, scanId) {
  return `${prefix}-${String(scanId).replaceAll('/', '_')}`;
}

function makeLog(type, message, context = {}) {
  return {
    type,
    message,
    scanId: context.scanId || '',
    productKey: context.productKey || '',
    sortingMode: context.sortingMode || '',
    selectedLocation: context.selectedLocation || null,
    commandId: context.commandId || '',
    details: context.details || {},
  };
}

export async function writeAutomationLogs(logs) {
  await Promise.allSettled(logs.map((log) => addDoc(collection(db, 'automationLogs'), {
    ...log,
    createdAt: serverTimestamp(),
  })));
}

export async function assignConfirmedScan(sourceCollection, sourceDocId) {
  const sourceRef = doc(db, sourceCollection, sourceDocId);
  const queueRef = doc(db, 'scanQueue', sourceDocId);
  const settingsRef = doc(db, 'settings', 'system');
  const locationRefs = Array.from({ length: TOTAL_LOCATIONS }, (_, index) => doc(db, 'locations', String(index + 1)));

  let committedLogs = [];
  const txTrace = [];

  try {
    const sourceSnapshotBeforeTransaction = await getDoc(sourceRef);
    const queueSnapshotBeforeTransaction = await getDoc(queueRef);
    const preflightScan = {
      ...(sourceSnapshotBeforeTransaction.exists() ? sourceSnapshotBeforeTransaction.data() : {}),
      ...(queueSnapshotBeforeTransaction.exists() ? queueSnapshotBeforeTransaction.data() : {}),
    };
    const preflightIdentity = scanIdentity(preflightScan, sourceDocId);
    const beltCommandRef = doc(db, 'commands', commandDocId('belt', preflightIdentity.scanId));
    const newCommandRef = doc(db, 'commands', commandDocId('go', preflightIdentity.scanId));
    const beltCommandQuery = query(
      collection(db, 'commands'),
      where('scanId', '==', preflightIdentity.scanId),
      where('command', '==', BELT_MOVE_COMMAND),
      limit(1),
    );
    const goCommandQuery = query(
      collection(db, 'commands'),
      where('scanId', '==', preflightIdentity.scanId),
      where('command', '==', 'GO'),
      limit(1),
    );
    const [existingBeltCommands, existingGoCommands] = await Promise.all([
      getDocs(beltCommandQuery),
      getDocs(goCommandQuery),
    ]);

    const result = await runTransaction(db, async (transaction) => {
      let hasWritten = false;
      const traceRead = async (description, ref) => {
        if (hasWritten) {
          txTrace.push(`ERROR_READ_AFTER_WRITE: ${description}`);
          throw new Error(`READ_AFTER_WRITE at ${description}`);
        }
        if (!ref || !ref.path) {
          txTrace.push(`INVALID_DOC_REF: ${description}`);
          throw new Error(`INVALID_DOC_REF: ${description}`);
        }
        txTrace.push(`READ: ${description}`);
        const snapshot = await transaction.get(ref);
        txTrace.push(`READ_OK: ${description}`);
        return snapshot;
      };
      const traceWrite = (description, writeOperation) => {
        txTrace.push(`WRITE: ${description}`);
        hasWritten = true;
        const result = writeOperation();
        txTrace.push(`WRITE_OK: ${description}`);
        return result;
      };

      const sourceSnapshot = await traceRead(`${sourceCollection}/${sourceDocId}`, sourceRef);
      const queueSnapshot = await traceRead(`scanQueue/${sourceDocId}`, queueRef);

      if (!sourceSnapshot.exists() && !queueSnapshot.exists()) {
        return {
          skipped: true,
          logs: [makeLog('PROCESS_ERROR', `Scan ${sourceDocId} does not exist.`, {
            scanId: sourceDocId,
            details: { sourceCollection, sourceDocId },
          })],
        };
      }

      const sourceScan = sourceSnapshot.exists() ? sourceSnapshot.data() : {};
      const queueScan = queueSnapshot.exists() ? queueSnapshot.data() : {};
      const scan = { ...sourceScan, ...queueScan };
      const identity = scanIdentity(scan, sourceDocId);
      const status = normalizeStatus(scan.status);
      const logs = [
        makeLog('SCAN_RECEIVED', `SCAN_RECEIVED ${identity.productKey}`, {
          ...identity,
          details: { sourceCollection, sourceDocId, status },
        }),
      ];

      if (PROCESSED_STATUSES.has(status)) {
        logs.push(makeLog('SCAN_IGNORED_ALREADY_PROCESSED', `Scan ${identity.scanId} already has status ${status}.`, {
          ...identity,
          details: { status },
        }));
        return { skipped: true, reason: 'already processed', logs };
      }

      if (status !== PROCESSABLE_STATUS) {
        logs.push(makeLog('SCAN_IGNORED_ALREADY_PROCESSED', `Scan ${identity.scanId} ignored because status is ${status || 'missing'}.`, {
          ...identity,
          details: { status },
        }));
        return { skipped: true, reason: `unsupported status ${status}`, logs };
      }

      const [
        settingsSnapshot,
        locationSnapshots,
      ] = await Promise.all([
        traceRead('settings/system', settingsRef),
        Promise.all(locationRefs.map((locationRef, index) => traceRead(`locations/${index + 1}`, locationRef))),
      ]);

      if (existingBeltCommands.empty) {
        const beltCommandId = beltCommandRef.id;
        traceWrite(`commands/${beltCommandId} belt ${BELT_MOVE_COMMAND}`, () => transaction.set(beltCommandRef, {
          commandId: beltCommandId,
          deviceId: ESP_DEVICE_ID,
          command: BELT_MOVE_COMMAND,
          status: 'pending',
          source: 'website-scan-processor',
          scanId: identity.scanId,
          payload: {
            operation: 'move_to_lifter_ir',
            stopOn: 'irLast',
          },
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }));
        logs.push(makeLog('BELT_MOVE_COMMAND_CREATED', `BELT_MOVE_COMMAND_CREATED ${BELT_MOVE_COMMAND}`, {
          ...identity,
          commandId: beltCommandId,
          details: {
            command: BELT_MOVE_COMMAND,
            payload: {
              operation: 'move_to_lifter_ir',
              stopOn: 'irLast',
            },
          },
        }));
      } else {
        const beltCommand = existingBeltCommands.docs[0];
        const beltCommandId = beltCommand.data().commandId || beltCommand.id;
        logs.push(makeLog('BELT_COMMAND_ALREADY_EXISTS', `BELT_COMMAND_ALREADY_EXISTS ${beltCommandId}`, {
          ...identity,
          commandId: beltCommandId,
          details: { existingCommandId: beltCommandId, command: BELT_MOVE_COMMAND },
        }));
      }

      logs.push(makeLog('SCAN_PROCESSING_STARTED', `Processing scan ${identity.scanId}.`, identity));
      logs.push(makeLog('COMMAND_DETERMINISTIC_ID_USED', `COMMAND_DETERMINISTIC_ID_USED ${beltCommandRef.id} ${newCommandRef.id}`, {
        ...identity,
        details: {
          beltCommandDocId: beltCommandRef.id,
          goCommandDocId: newCommandRef.id,
        },
      }));

      logs.push(makeLog('COMMAND_DUPLICATE_CHECK', `Found ${existingGoCommands.size} existing GO commands for scan ${identity.scanId}.`, {
        ...identity,
        details: { existingCommands: existingGoCommands.size, command: 'GO' },
      }));

      if (!existingGoCommands.empty) {
        const goCommand = existingGoCommands.docs[0];
        const commandId = goCommand.data().commandId || goCommand.id;
        logs.push(makeLog('COMMAND_ALREADY_EXISTS', `Command already exists for scan ${identity.scanId}: ${commandId}.`, {
          ...identity,
          commandId,
          details: { existingCommandId: commandId },
        }));
        traceWrite(`scanQueue/${sourceDocId} mark assigned existing GO`, () => transaction.set(queueRef, {
          ...identity,
          source: scan.source || sourceCollection,
          status: 'ASSIGNED',
          assignmentStatus: 'COMMAND_CREATED',
          commandId,
          updatedAt: serverTimestamp(),
        }, { merge: true }));
        if (sourceCollection === 'scans') {
          traceWrite(`${sourceCollection}/${sourceDocId} mark assigned existing GO`, () => transaction.set(sourceRef, {
            status: 'ASSIGNED',
            assignmentStatus: 'COMMAND_CREATED',
            commandId,
            updatedAt: serverTimestamp(),
          }, { merge: true }));
        }
        return { skipped: true, reason: 'command already exists', commandId, logs };
      }

      const sortingMode = String(settingsSnapshot.data()?.sortingMode || '').trim();
      logs.push(makeLog('SORTING_MODE_READ', `SORTING_MODE_READ ${sortingMode || 'missing'}`, {
        ...identity,
        sortingMode,
      }));

      if (!VALID_SORTING_STRATEGIES.has(sortingMode)) {
        const errorMessage = 'Missing or invalid settings/system.sortingMode.';
        logs.push(makeLog('PROCESS_ERROR', errorMessage, {
          ...identity,
          sortingMode,
          details: { error: errorMessage },
        }));
        traceWrite(`scanQueue/${sourceDocId} missing sortingMode error`, () => transaction.set(queueRef, {
          ...identity,
          source: scan.source || sourceCollection,
          status: 'ERROR',
          errorCode: 'missing-sortingMode',
          errorMessage,
          updatedAt: serverTimestamp(),
        }, { merge: true }));
        return { skipped: true, reason: 'missing sortingMode', logs };
      }

      logs.push(makeLog('LOCATIONS_READ', `LOCATIONS_READ ${locationSnapshots.length}`, {
        ...identity,
        sortingMode,
        details: { locationsRead: locationSnapshots.length },
      }));

      const {
        emptyLocations,
        scores,
        selectedLocation,
        resolvedStrategy,
        rejectedLocations,
        tieBreakUsed,
      } = chooseStorageLocation(identity, locationSnapshots, sortingMode);
      logs.push(makeLog('SORT_STRATEGY_SELECTED', `SORT_STRATEGY_SELECTED ${sortingMode} -> ${resolvedStrategy}`, {
        ...identity,
        sortingMode,
        details: { requestedStrategy: sortingMode, resolvedStrategy },
      }));
      logs.push(makeLog('EMPTY_LOCATIONS_FOUND', `EMPTY_LOCATIONS_FOUND ${emptyLocations.length}`, {
        ...identity,
        sortingMode,
        details: { emptyLocations },
      }));
      if (rejectedLocations.length > 0) {
        logs.push(makeLog('SORT_REJECTED_NON_EMPTY', `SORT_REJECTED_NON_EMPTY ${rejectedLocations.join(', ')}`, {
          ...identity,
          sortingMode,
          details: { rejectedLocations },
        }));
      }
      const occupiedFlagRejectedLocations = locationSnapshots
        .map((snapshot, index) => ({
          locationId: index + 1,
          ...(snapshot.exists() ? snapshot.data() : {}),
        }))
        .filter((location) => {
          const status = String(location.status || '').trim().toLowerCase();
          return (status === '' || status === 'empty') && isRejectedByOccupiedFlag(location);
        })
        .map((location) => location.locationId);
      if (occupiedFlagRejectedLocations.length > 0) {
        logs.push(makeLog('LOCATION_REJECTED_OCCUPIED_FLAG', `LOCATION_REJECTED_OCCUPIED_FLAG ${occupiedFlagRejectedLocations.join(', ')}`, {
          ...identity,
          sortingMode,
          details: { rejectedLocations: occupiedFlagRejectedLocations },
        }));
      }
      logs.push(makeLog('LOCATION_SCORING_STARTED', `LOCATION_SCORING_STARTED ${sortingMode}`, {
        ...identity,
        sortingMode,
        details: { requestedStrategy: sortingMode, resolvedStrategy, sortPath: getSortPath() },
      }));
      scores.forEach((scoreItem) => {
        logs.push(makeLog('SORT_SIZE_ORDER_SCORE', `SORT_SIZE_ORDER_SCORE ${scoreItem.locationId}:${scoreItem.details.size?.score ?? 0}`, {
          ...identity,
          sortingMode,
          selectedLocation: scoreItem.locationId,
          details: scoreItem.details.size || {},
        }));
        ['brand', 'model', 'color', 'sku'].forEach((field) => {
          logs.push(makeLog('SORT_CLUSTER_SCORE', `SORT_CLUSTER_SCORE ${field} ${scoreItem.locationId}:${scoreItem.details[field]?.score ?? 0}`, {
            ...identity,
            sortingMode,
            selectedLocation: scoreItem.locationId,
            details: scoreItem.details[field] || { field },
          }));
        });
        logs.push(makeLog('SORT_CANDIDATE_SCORE', `SORT_CANDIDATE_SCORE ${scoreItem.locationId}:${scoreItem.score}`, {
          ...identity,
          sortingMode,
          selectedLocation: scoreItem.locationId,
          details: scoreItem.details,
        }));
      });
      if (tieBreakUsed) {
        logs.push(makeLog('SORT_TIE_BREAK_USED', `SORT_TIE_BREAK_USED ${scores[0]?.locationId || 'none'}`, {
          ...identity,
          sortingMode,
          selectedLocation: scores[0]?.locationId || null,
          details: {
            topCandidates: scores.filter((item) => item.score === scores[0]?.score).map((item) => item.locationId),
            tieBreakOrder: ['matchingClusterAdjacency', 'centerDistance', 'movementCost', 'locationNumber'],
          },
        }));
      }
      logs.push(makeLog('LOCATION_SCORE_RESULT', `LOCATION_SCORE_RESULT ${scores.map((item) => `${item.locationId}:${item.score}`).join(', ') || 'none'}`, {
        ...identity,
        sortingMode,
        details: { scores },
      }));

      if (!selectedLocation) {
        const errorMessage = sortingMode === 'nearest_location_priority'
          ? 'NO_AVAILABLE_LOCATION'
          : 'No empty warehouse location is available.';
        logs.push(makeLog('PROCESS_ERROR', errorMessage, {
          ...identity,
          sortingMode,
          details: { error: errorMessage, emptyLocations },
        }));
        traceWrite(`scanQueue/${sourceDocId} no empty locations error`, () => transaction.set(queueRef, {
          ...identity,
          source: scan.source || sourceCollection,
          status: 'ERROR',
          errorCode: sortingMode === 'nearest_location_priority' ? 'NO_AVAILABLE_LOCATION' : 'no-empty-locations',
          errorMessage,
          updatedAt: serverTimestamp(),
        }, { merge: true }));
        return { skipped: true, reason: sortingMode === 'nearest_location_priority' ? 'NO_AVAILABLE_LOCATION' : 'no empty locations', logs };
      }

      const { inPosition, outPosition } = locationPositions(selectedLocation);
      const commandId = newCommandRef.id;
      const payload = {
        operation: 'put',
        scanId: identity.scanId,
        locationId: selectedLocation,
        inPosition,
        outPosition,
        brand: identity.brand,
        model: identity.model,
        color: identity.color,
        size: identity.size,
        productKey: identity.productKey,
        normalizedSku: identity.normalizedSku,
      };

      logs.push(makeLog('LOCATION_SELECTED', `LOCATION_SELECTED ${selectedLocation}`, {
        ...identity,
        sortingMode,
        selectedLocation,
        details: { inPosition, outPosition },
      }));
      logs.push(makeLog('SORT_SELECTED_LOCATION', `SORT_SELECTED_LOCATION ${selectedLocation}`, {
        ...identity,
        sortingMode,
        selectedLocation,
        details: { requestedStrategy: sortingMode, resolvedStrategy, inPosition, outPosition },
      }));

      traceWrite(`locations/${selectedLocation} reserve`, () => markLocationReserved(
        transaction,
        doc(db, 'locations', String(selectedLocation)),
        {
          locationId: selectedLocation,
          identity,
          commandId,
          inPosition,
          outPosition,
          sortingMode,
        },
      ));
      logs.push(makeLog('LOCATION_RESERVED', `LOCATION_RESERVED ${selectedLocation}`, {
        ...identity,
        sortingMode,
        selectedLocation,
        commandId,
        details: {
          locationId: selectedLocation,
          status: 'reserved',
          reserved: true,
          occupied: false,
          isOccupied: false,
          productId: identity.normalizedSku,
          sku: identity.normalizedSku,
          commandId,
        },
      }));

      traceWrite(`commands/${commandId} GO ${inPosition}`, () => transaction.set(newCommandRef, {
        commandId,
        deviceId: ESP_DEVICE_ID,
        command: 'GO',
        arduinoCommand: `GO ${inPosition}`,
        type: 'GO',
        position: inPosition,
        status: 'pending',
        source: 'website-scan-processor',
        scanId: identity.scanId,
        locationId: selectedLocation,
        payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));
      logs.push(makeLog('COMMAND_CREATED', `COMMAND_CREATED GO ${inPosition}`, {
        ...identity,
        sortingMode,
        selectedLocation,
        commandId,
        details: { command: 'GO', position: inPosition, payload },
      }));

      traceWrite(`scanQueue/${sourceDocId} assign scan`, () => transaction.set(queueRef, {
        ...identity,
        source: scan.source || sourceCollection,
        status: 'ASSIGNED',
        assignmentStatus: 'COMMAND_CREATED',
        selectedLocation,
        locationId: selectedLocation,
        inPosition,
        outPosition,
        commandId,
        updatedAt: serverTimestamp(),
      }, { merge: true }));
      if (sourceCollection === 'scans') {
        traceWrite(`${sourceCollection}/${sourceDocId} assign scan`, () => transaction.set(sourceRef, {
          status: 'ASSIGNED',
          selectedLocation,
          locationId: selectedLocation,
          inPosition,
          outPosition,
          commandId,
          updatedAt: serverTimestamp(),
        }, { merge: true }));
      }
      logs.push(makeLog('SCAN_ASSIGNED', `SCAN_ASSIGNED ${identity.scanId}`, {
        ...identity,
        sortingMode,
        selectedLocation,
        commandId,
        details: { inPosition, outPosition },
      }));

      // Product stock is recomputed from full locations after commit; reserved locations do not count.
      // Status plan: CONFIRMED -> ASSIGNED -> COMMAND_CREATED -> STORED/DONE after storage completion.
      return {
        skipped: false,
        scanId: identity.scanId,
        productKey: identity.productKey,
        normalizedSku: identity.normalizedSku,
        commandId,
        locationId: selectedLocation,
        inPosition,
        outPosition,
        logs,
      };
    });

    committedLogs = result.logs || [];
    await writeAutomationLogs(committedLogs.map((log) => ({
      ...log,
      details: {
        ...log.details,
        txTrace,
      },
    })));
    if (!result.skipped && result.normalizedSku) {
      await recomputeProductInventoryFromLocations(result.normalizedSku);
    }
    return result;
  } catch (error) {
    console.table(txTrace);
    const beltErrorLog = makeLog('BELT_MOVE_COMMAND_ERROR', error.message || String(error), {
      scanId: sourceDocId,
      details: { sourceCollection, sourceDocId, error: error.message || String(error), txTrace },
    });
    const errorLog = makeLog('PROCESS_ERROR', error.message || String(error), {
      scanId: sourceDocId,
      details: { sourceCollection, sourceDocId, error: error.message || String(error), txTrace },
    });
    await writeAutomationLogs([
      ...committedLogs.map((log) => ({
        ...log,
        details: {
          ...log.details,
          txTrace,
        },
      })),
      beltErrorLog,
      errorLog,
    ]);
    throw error;
  }
}
