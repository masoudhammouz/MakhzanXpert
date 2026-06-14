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

    const confirmedScansQuery = query(
      collection(db, 'scanQueue'),
      where('status', '==', 'CONFIRMED'),
      limit(10),
    );

    const unsubscribe = onSnapshot(
      confirmedScansQuery,
      (snapshot) => {
        snapshot.docs.forEach((scanDoc) => {
          if (processingScanIds.current.has(scanDoc.id)) return;

          processingScanIds.current.add(scanDoc.id);
          assignConfirmedScan(scanDoc.id)
            .then((result) => {
              if (result.skipped) {
                console.info('[SCAN_ASSIGNMENT_SKIPPED]', scanDoc.id, result.reason);
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
              console.error('[SCAN_ASSIGNMENT_FAILED]', scanDoc.id, error);
              logScanProcessorActivity(
                'SCAN_ASSIGNMENT_FAILED',
                `Scan ${scanDoc.id} assignment failed: ${error.message || error}`,
                'error',
              );
            })
            .finally(() => {
              processingScanIds.current.delete(scanDoc.id);
            });
        });
      },
      (error) => {
        console.error('[SCAN_ASSIGNMENT_LISTENER_FAILED]', error);
        logScanProcessorActivity(
          'SCAN_ASSIGNMENT_LISTENER_FAILED',
          `Scan assignment listener failed: ${error.message || error}`,
          'error',
        );
      },
    );

    return unsubscribe;
  }, [currentUser, loading]);

  return null;
}

export default ScanAssignmentWorker;
