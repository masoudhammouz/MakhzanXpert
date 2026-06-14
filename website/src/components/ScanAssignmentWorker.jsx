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

    console.log('SCAN_ASSIGNMENT_WORKER_MOUNTED');

    const processConfirmedScanDoc = (sourceCollection, scanDoc) => {
      const data = scanDoc.data();
      if (data?.status !== 'CONFIRMED') return;

      console.log('CONFIRMED_SCAN_FOUND', {
        sourceCollection,
        scanDocId: scanDoc.id,
        scanId: data.scanId,
        productKey: data.productKey,
      });

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
    };

    const attachFallbackListener = (sourceCollection) => {
      console.log('SCAN_QUEUE_LISTENER_ATTACHED', {
        sourceCollection,
        mode: 'fallback-full-collection',
      });

      return onSnapshot(
        collection(db, sourceCollection),
        (snapshot) => {
          console.log('SCAN_QUEUE_SNAPSHOT_RECEIVED', {
            sourceCollection,
            mode: 'fallback-full-collection',
            size: snapshot.size,
          });
          snapshot.docs.forEach((scanDoc) => processConfirmedScanDoc(sourceCollection, scanDoc));
        },
        (error) => {
          console.error('[SCAN_ASSIGNMENT_FALLBACK_LISTENER_FAILED]', sourceCollection, error);
          logScanProcessorActivity(
            'SCAN_ASSIGNMENT_LISTENER_FAILED',
            `${sourceCollection} fallback scan listener failed: ${error.message || error}`,
            'error',
          );
        },
      );
    };

    const listenForConfirmedScans = (sourceCollection) => {
      let fallbackUnsubscribe = null;
      const confirmedScansQuery = query(
        collection(db, sourceCollection),
        where('status', '==', 'CONFIRMED'),
        limit(10),
      );

      console.log('SCAN_QUEUE_LISTENER_ATTACHED', {
        sourceCollection,
        mode: 'where-status-CONFIRMED',
      });

      const unsubscribe = onSnapshot(
        confirmedScansQuery,
        (snapshot) => {
          console.log('SCAN_QUEUE_SNAPSHOT_RECEIVED', {
            sourceCollection,
            mode: 'where-status-CONFIRMED',
            size: snapshot.size,
          });
          snapshot.docs.forEach((scanDoc) => processConfirmedScanDoc(sourceCollection, scanDoc));
        },
        (error) => {
          console.error('[SCAN_ASSIGNMENT_LISTENER_FAILED]', sourceCollection, error);
          logScanProcessorActivity(
            'SCAN_ASSIGNMENT_LISTENER_FAILED',
            `${sourceCollection} scan assignment listener failed: ${error.message || error}`,
            'error',
          );
          if (!fallbackUnsubscribe) {
            fallbackUnsubscribe = attachFallbackListener(sourceCollection);
          }
        },
      );

      return () => {
        unsubscribe();
        if (fallbackUnsubscribe) fallbackUnsubscribe();
      };
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
