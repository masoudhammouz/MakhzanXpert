import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase/firebase.js';
import { buildNormalizedSku } from './productVisibility.js';

export const LOCATION_FILL_DELAY_MS = 12000;

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function compactIdentityValues(values) {
  return new Set(values.map(normalizeIdentity).filter(Boolean));
}

function getTimestampMs(value) {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return 0;
}

function productIdentityValues(product, fallbackId = '') {
  return compactIdentityValues([
    fallbackId,
    product?.id,
    product?.productId,
    product?.sku,
    product?.normalizedSku,
    product?.productKey,
    buildNormalizedSku(product),
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

function isFullInventoryLocation(location) {
  return (
    String(location?.status || '').toLowerCase() === 'full' &&
    (location?.occupied === true || location?.isOccupied === true)
  );
}

function countFullLocationsForProduct(locations, product, productId) {
  const productIds = productIdentityValues(product, productId);
  return locations.filter((location) => (
    isFullInventoryLocation(location) &&
    identitiesOverlap(productIds, locationIdentityValues(location))
  )).length;
}

function productSkuFromLocation(location) {
  return (
    location?.sku ||
    location?.normalizedSku ||
    location?.productId ||
    buildNormalizedSku(location)
  );
}

async function logInventoryActivity(type, message, details = {}) {
  const data = {
    type,
    activityType: type,
    message,
    details,
    source: 'website-inventory-sync',
    sourceDevice: 'website',
    status: 'info',
    createdAt: serverTimestamp(),
  };

  await Promise.allSettled([
    addDoc(collection(db, 'systemActivity'), data),
    addDoc(collection(db, 'activityLog'), data),
  ]);
}

async function updateProductStocksFromLocations(products, locations, context = {}) {
  if (products.length === 0) return { updatedProducts: 0, products: [] };

  const batch = writeBatch(db);
  const updatedProducts = products.map(({ id, ref, data }) => {
    const count = countFullLocationsForProduct(locations, data, id);
    const update = {
      stock: count,
      quantity: count,
      availableQuantity: count,
      availableStock: count,
      inStock: count > 0,
      isAvailable: count > 0,
      inventorySource: 'locations',
      updatedAt: serverTimestamp(),
    };

    batch.set(ref, update, { merge: true });
    return { id, count };
  });

  await batch.commit();

  console.info('[INVENTORY_RECOMPUTED_FROM_LOCATIONS]', {
    ...context,
    updatedProducts: updatedProducts.length,
  });
  await logInventoryActivity(
    'INVENTORY_RECOMPUTED_FROM_LOCATIONS',
    `Inventory recomputed from ${locations.length} locations for ${updatedProducts.length} product${updatedProducts.length === 1 ? '' : 's'}.`,
    { ...context, updatedProducts },
  );

  await Promise.allSettled(updatedProducts.map((product) => {
    console.info('[PRODUCT_STOCK_UPDATED]', product);
    return logInventoryActivity(
      'PRODUCT_STOCK_UPDATED',
      `Product ${product.id} stock updated to ${product.count}.`,
      { ...context, productId: product.id, stock: product.count },
    );
  }));

  return { updatedProducts: updatedProducts.length, products: updatedProducts };
}

export function markLocationReserved(transaction, locationRef, reservation) {
  const {
    locationId,
    identity,
    commandId,
    inPosition,
    outPosition,
    sortingMode,
  } = reservation;
  const sku = identity.normalizedSku || buildNormalizedSku(identity);

  const data = {
    status: 'reserved',
    reserved: true,
    occupied: false,
    isOccupied: false,
    locationId,
    position: locationId,
    productId: sku,
    sku,
    normalizedSku: sku,
    productKey: identity.productKey,
    brand: identity.brand,
    model: identity.model,
    color: identity.color,
    size: identity.size,
    scanId: identity.scanId,
    commandId,
    inPosition,
    outPosition,
    sortingMode,
    reservedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  transaction.set(locationRef, data, { merge: true });
  return data;
}

export async function recomputeProductInventoryFromLocations(productIdOrSku) {
  const locationsSnapshot = await getDocs(collection(db, 'locations'));
  const locations = locationsSnapshot.docs.map((locationDoc) => ({ id: locationDoc.id, ...locationDoc.data() }));
  const productRef = doc(db, 'products', String(productIdOrSku));
  const productSnapshot = await getDoc(productRef);

  let products = [];
  if (productSnapshot.exists()) {
    products = [{ id: productSnapshot.id, ref: productRef, data: { id: productSnapshot.id, ...productSnapshot.data() } }];
  } else {
    const target = normalizeIdentity(productIdOrSku);
    const productsSnapshot = await getDocs(collection(db, 'products'));
    products = productsSnapshot.docs
      .map((productDoc) => ({ id: productDoc.id, ref: productDoc.ref, data: { id: productDoc.id, ...productDoc.data() } }))
      .filter((product) => productIdentityValues(product.data, product.id).has(target));
  }

  return updateProductStocksFromLocations(products, locations, { productIdOrSku });
}

export async function syncAllProductInventoryFromLocations() {
  const [locationsSnapshot, productsSnapshot] = await Promise.all([
    getDocs(collection(db, 'locations')),
    getDocs(collection(db, 'products')),
  ]);
  const locations = locationsSnapshot.docs.map((locationDoc) => ({ id: locationDoc.id, ...locationDoc.data() }));
  const products = productsSnapshot.docs
    .map((productDoc) => ({ id: productDoc.id, ref: productDoc.ref, data: { id: productDoc.id, ...productDoc.data() } }));

  return updateProductStocksFromLocations(products, locations, { scope: 'all-products' });
}

export async function markLocationFull(locationId) {
  const locationRef = doc(db, 'locations', String(locationId));
  const location = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(locationRef);
    if (!snapshot.exists()) return null;

    const current = { id: snapshot.id, ...snapshot.data() };
    if (String(current.status || '').toLowerCase() !== 'reserved') return null;

    transaction.set(locationRef, {
      status: 'full',
      reserved: false,
      occupied: true,
      isOccupied: true,
      filledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    return current;
  });

  if (!location) return null;

  const productIdOrSku = productSkuFromLocation(location);
  console.info('[LOCATION_MARKED_FULL]', { locationId, productIdOrSku, scanId: location.scanId, commandId: location.commandId });
  await logInventoryActivity(
    'LOCATION_MARKED_FULL',
    `Location ${locationId} marked full for ${productIdOrSku}.`,
    { locationId, productIdOrSku, scanId: location.scanId, commandId: location.commandId },
  );
  await recomputeProductInventoryFromLocations(productIdOrSku);
  return location;
}

export async function markPickedLocationEmpty(locationId, context = {}) {
  const locationRef = doc(db, 'locations', String(locationId));
  const pickedLocation = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(locationRef);
    if (!snapshot.exists()) return null;

    const current = { id: snapshot.id, ...snapshot.data() };
    if (String(current.status || '').toLowerCase() !== 'full') return null;

    transaction.set(locationRef, {
      status: 'empty',
      reserved: false,
      occupied: false,
      isOccupied: false,
      clearedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      productKey: deleteField(),
      productId: deleteField(),
      sku: deleteField(),
      normalizedSku: deleteField(),
      brand: deleteField(),
      model: deleteField(),
      color: deleteField(),
      size: deleteField(),
      scanId: deleteField(),
      commandId: deleteField(),
      reservedAt: deleteField(),
      filledAt: deleteField(),
      inPosition: deleteField(),
      outPosition: deleteField(),
      sortingMode: deleteField(),
      boxId: deleteField(),
    }, { merge: true });

    return current;
  });

  if (!pickedLocation) return null;

  const productIdOrSku = productSkuFromLocation(pickedLocation);
  console.info('[LOCATION_MARKED_EMPTY_AFTER_PICK]', { locationId, productIdOrSku, ...context });
  await logInventoryActivity(
    'LOCATION_MARKED_EMPTY_AFTER_PICK',
    `Location ${locationId} cleared after picking ${productIdOrSku}.`,
    { locationId, productIdOrSku, ...context },
  );
  await recomputeProductInventoryFromLocations(productIdOrSku);
  return pickedLocation;
}

export function markLocationFullAfterDelay(locationId, options = {}) {
  const {
    reservedAt,
    delayMs = LOCATION_FILL_DELAY_MS,
    scanId = '',
    commandId = '',
    productIdOrSku = '',
    onComplete,
  } = options;
  const reservedAtMs = getTimestampMs(reservedAt) || Date.now();
  const remainingMs = Math.max(0, delayMs - (Date.now() - reservedAtMs));

  console.info('[LOCATION_FILL_DELAY_STARTED]', {
    locationId,
    delayMs,
    remainingMs,
    scanId,
    commandId,
    productIdOrSku,
  });
  logInventoryActivity(
    'LOCATION_FILL_DELAY_STARTED',
    `Location ${locationId} will be marked full after ${remainingMs}ms.`,
    { locationId, delayMs, remainingMs, scanId, commandId, productIdOrSku },
  ).catch((error) => console.error('[LOCATION_FILL_DELAY_LOG_FAILED]', error));

  return setTimeout(async () => {
    try {
      await markLocationFull(locationId);
    } catch (error) {
      console.error('[LOCATION_MARKED_FULL_FAILED]', { locationId, error });
    } finally {
      if (onComplete) onComplete();
    }
  }, remainingMs);
}
