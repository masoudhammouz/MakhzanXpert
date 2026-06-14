import { useEffect, useRef } from 'react';
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { db } from '../firebase/firebase.js';
import { useAuth } from '../context/AuthContext.jsx';
import { assignConfirmedScan } from '../utils/scanAssignmentProcessor.js';

function logScanProcessorActivity(activityType, message, status = 'info') {
  const data = {
    type: activityType,
    activityType,
    message,
    source: 'website-scan-processor',
    sourceDevice: 'website',
    status,
    createdAt: serverTimestamp(),
  };
  return Promise.allSettled([
    addDoc(collection(db, 'systemActivity'), data),
    addDoc(collection(db, 'activityLog'), data),
  ]);
}

function ScanAssignmentWorker() {
  const { currentUser, loading } = useAuth();
  const processingScanIds = useRef(new Set());

  useEffect(() => {
    if (loading || !currentUser) return undefined;

    const listenForConfirmedScans = (sourceCollection) => {
      const confirmedScansQuery = query(
        collection(db, sourceCollection),
        where('status', '==', 'CONFIRMED'),
        limit(10),
      );

      return onSnapshot(
        confirmedScansQuery,
        (snapshot) => {
          snapshot.docs.forEach((scanDoc) => {
            const processingKey = `${sourceCollection}/${scanDoc.id}`;
            if (processingScanIds.current.has(processingKey)) return;

            processingScanIds.current.add(processingKey);
            assignConfirmedScan(sourceCollection, scanDoc.id)
              .then((result) => {
                if (result.skipped) {
                  console.info('[SCAN_ASSIGNMENT_SKIPPED]', processingKey, result.reason);
                  return;
                }
                console.info('[SCAN_ASSIGNED]', result);
                logScanProcessorActivity(
                  'SCAN_ASSIGNED',
                  `Scan ${result.scanId} assigned to location ${result.locationId}; GO ${result.inPosition} command ${result.commandId} created.`,
                  'success',
                );
              })
              .catch((error) => {
                console.error('[SCAN_ASSIGNMENT_FAILED]', processingKey, error);
                logScanProcessorActivity(
                  'SCAN_ASSIGNMENT_FAILED',
                  `Scan ${processingKey} assignment failed: ${error.message || error}`,
                  'error',
                );
              })
              .finally(() => {
                processingScanIds.current.delete(processingKey);
              });
          });
        },
        (error) => {
          console.error('[SCAN_ASSIGNMENT_LISTENER_FAILED]', sourceCollection, error);
          logScanProcessorActivity(
            'SCAN_ASSIGNMENT_LISTENER_FAILED',
            `${sourceCollection} scan assignment listener failed: ${error.message || error}`,
            'error',
          );
        },
      );
    };

    const unsubscribeScanQueue = listenForConfirmedScans('scanQueue');
    const unsubscribeScans = listenForConfirmedScans('scans');

    return () => {
      unsubscribeScanQueue();
      unsubscribeScans();
    };
  }, [currentUser, loading]);

  return null;
}

export default ScanAssignmentWorker;
