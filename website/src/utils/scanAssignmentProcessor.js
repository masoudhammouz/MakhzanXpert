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

const STRATEGY_WEIGHTS = {
  brand: { brand: 10 },
  model: { model: 10 },
  color: { color: 10 },
  size: { size: 10 },
  brand_size: { brand: 10, size: 7 },
  color_size: { color: 10, size: 7 },
  model_size: { model: 10, size: 7 },
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
  return (status === '' || status === 'empty') && !isRejectedByOccupiedFlag(location);
}

function scoreNeighbor(scan, neighbor, sortingMode) {
  const weights = STRATEGY_WEIGHTS[sortingMode] || {};
  return Object.entries(weights).reduce((score, [field, weight]) => {
    return normalize(scan[field]) && normalize(scan[field]) === normalize(neighbor[field]) ? score + weight : score;
  }, 0);
}

function scoreLocation(scan, locationsById, locationId, sortingMode) {
  return (NEIGHBORS[locationId] || []).reduce((score, neighborId) => {
    return score + scoreNeighbor(scan, locationsById.get(neighborId) || {}, sortingMode);
  }, 0);
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
  const { locationsById, emptyLocations } = buildLocationContext(locationSnapshots);
  const scores = emptyLocations
    .map((locationId) => ({
      locationId,
      score: scoreLocation(scan, locationsById, locationId, sortingMode),
    }))
    .sort((left, right) => right.score - left.score || left.locationId - right.locationId);

  const selectedLocation = scores.length === 0 ? null : scores[0].score > 0 ? scores[0].locationId : emptyLocations[0];
  return { emptyLocations, scores, selectedLocation };
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

      const { emptyLocations, scores, selectedLocation } = chooseStorageLocation(identity, locationSnapshots, sortingMode);
      logs.push(makeLog('EMPTY_LOCATIONS_FOUND', `EMPTY_LOCATIONS_FOUND ${emptyLocations.length}`, {
        ...identity,
        sortingMode,
        details: { emptyLocations },
      }));
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
        details: { strategyWeights: STRATEGY_WEIGHTS[sortingMode] },
      }));
      logs.push(makeLog('LOCATION_SCORE_RESULT', `LOCATION_SCORE_RESULT ${scores.map((item) => `${item.locationId}:${item.score}`).join(', ') || 'none'}`, {
        ...identity,
        sortingMode,
        details: { scores },
      }));

      if (!selectedLocation) {
        const errorMessage = 'No empty warehouse location is available.';
        logs.push(makeLog('PROCESS_ERROR', errorMessage, {
          ...identity,
          sortingMode,
          details: { error: errorMessage, emptyLocations },
        }));
        traceWrite(`scanQueue/${sourceDocId} no empty locations error`, () => transaction.set(queueRef, {
          ...identity,
          source: scan.source || sourceCollection,
          status: 'ERROR',
          errorCode: 'no-empty-locations',
          errorMessage,
          updatedAt: serverTimestamp(),
        }, { merge: true }));
        return { skipped: true, reason: 'no empty locations', logs };
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

      traceWrite(`locations/${selectedLocation} reserve`, () => transaction.set(doc(db, 'locations', String(selectedLocation)), {
        status: 'reserved',
        locationId: selectedLocation,
        position: selectedLocation,
        productId: identity.normalizedSku,
        normalizedSku: identity.normalizedSku,
        productKey: identity.productKey,
        brand: identity.brand,
        model: identity.model,
        color: identity.color,
        size: identity.size,
        scanId: identity.scanId,
        updatedAt: serverTimestamp(),
      }, { merge: true }));
      logs.push(makeLog('LOCATION_RESERVED', `LOCATION_RESERVED ${selectedLocation}`, {
        ...identity,
        sortingMode,
        selectedLocation,
        details: { locationId: selectedLocation },
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

      // Product stock is intentionally not incremented here.
      // Status plan: CONFIRMED -> ASSIGNED -> COMMAND_CREATED -> STORED/DONE after storage completion.
      return {
        skipped: false,
        scanId: identity.scanId,
        productKey: identity.productKey,
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
