const FIREBASE_API_KEY = process.env.MAKHZAN_FIREBASE_API_KEY || 'AIzaSyBVgBcp5ouNM_ycz0A5dxHlySN_IuZ2CJo';
const FIREBASE_PROJECT_ID = process.env.MAKHZAN_FIREBASE_PROJECT_ID || 'makhzanxpert';
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const INTERNAL_PRODUCT_CATALOG = [
  { brand: 'NIKE', model: 'AIR FORCE', color: 'WHITE', size: '40', price: 120 },
  { brand: 'NIKE', model: 'AIR FORCE', color: 'WHITE', size: '42', price: 120 },
  { brand: 'NIKE', model: 'AIR MAX', color: 'BLACK', size: '42', price: 150 },
  { brand: 'NIKE', model: 'DUNK LOW', color: 'GREEN', size: '40', price: 115 },
  { brand: 'ADIDAS', model: 'SAMBA', color: 'WHITE', size: '38', price: 100 },
  { brand: 'ADIDAS', model: 'SAMBA', color: 'WHITE', size: '40', price: 100 },
  { brand: 'ADIDAS', model: 'GAZELLE', color: 'GREEN', size: '41', price: 105 },
  { brand: 'ADIDAS', model: 'CAMPUS', color: 'BLACK', size: '39', price: 105 },
  { brand: 'PUMA', model: 'SUEDE CLASSIC', color: 'RED', size: '38', price: 90 },
  { brand: 'PUMA', model: 'SUEDE CLASSIC', color: 'RED', size: '40', price: 90 },
  { brand: 'PUMA', model: 'RS', color: 'BLACK', size: '41', price: 125 },
  { brand: 'PUMA', model: 'CALI', color: 'WHITE', size: '39', price: 95 },
  { brand: 'SKECHERS', model: 'GO WALK', color: 'NAVY', size: '39', price: 80 },
  { brand: 'SKECHERS', model: 'GO WALK', color: 'NAVY', size: '41', price: 80 },
  { brand: 'SKECHERS', model: 'ARCH FIT', color: 'NAVY', size: '42', price: 90 },
  { brand: 'SKECHERS', model: 'UNO', color: 'RED', size: '43', price: 85 },
];

function url(path) {
  return `${FIRESTORE_BASE_URL}/${path.replace(/^\/+/, '')}?key=${FIREBASE_API_KEY}`;
}

function pathFromName(name) {
  const marker = '/documents/';
  return name.includes(marker) ? name.split(marker, 2)[1] : name.replace(/^\/+/, '');
}

async function requestJson(requestUrl, options = {}) {
  const response = await fetch(requestUrl, options);
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.method || 'GET'} ${requestUrl} failed: ${response.status} ${text}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function timestamp(value = new Date()) {
  return { timestampValue: value.toISOString() };
}

function valueToFirestore(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(valueToFirestore) } };
  if (value?.timestampValue) return value;
  return { stringValue: String(value) };
}

function toFields(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, valueToFirestore(value)]));
}

async function listDocs(collectionPath) {
  const docs = [];
  let pageToken = '';
  while (true) {
    const params = new URLSearchParams({ pageSize: '100', key: FIREBASE_API_KEY });
    if (pageToken) params.set('pageToken', pageToken);
    const listUrl = `${FIRESTORE_BASE_URL}/${collectionPath}?${params.toString()}`;
    const payload = await requestJson(listUrl);
    if (!payload) return docs;
    docs.push(...(payload.documents || []));
    pageToken = payload.nextPageToken || '';
    if (!pageToken) return docs;
  }
}

async function deleteDoc(pathOrName) {
  await requestJson(url(pathFromName(pathOrName)), { method: 'DELETE' });
}

async function setDoc(path, data) {
  await requestJson(url(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) }),
  });
}

async function addDoc(collectionPath, data) {
  await requestJson(url(collectionPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) }),
  });
}

async function deleteCollection(collectionPath) {
  let deleted = 0;
  while (true) {
    const docs = await listDocs(collectionPath);
    if (!docs.length) return deleted;
    for (const doc of docs) {
      await deleteDoc(doc.name);
      deleted += 1;
    }
  }
}

function normalizeSkuPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function normalizeSlugPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function normalizedSku(product) {
  return ['brand', 'model', 'color', 'size'].map((field) => normalizeSkuPart(product[field])).join('_');
}

function slug(product) {
  return ['brand', 'model', 'color', 'size'].map((field) => normalizeSlugPart(product[field])).join('-');
}

function productName(product) {
  return productKey(product);
}

function productKey(product) {
  return ['brand', 'model', 'color', 'size'].map((field) => String(product[field] || '').trim().toUpperCase()).join('|');
}

async function recreateLocations() {
  for (let id = 1; id <= 9; id += 1) {
    await setDoc(`locations/${id}`, {
      id,
      status: 'empty',
      normalizedSku: '',
      productId: '',
      productKey: '',
      boxId: '',
      brand: '',
      model: '',
      color: '',
      size: '',
      updatedAt: timestamp(),
    });
  }
}

async function recreateProducts() {
  for (const product of INTERNAL_PRODUCT_CATALOG) {
    const id = normalizedSku(product);
    await setDoc(`products/${id}`, {
      id,
      normalizedSku: id,
      productKey: productKey(product),
      slug: slug(product),
      brand: product.brand,
      model: product.model,
      color: product.color,
      size: product.size,
      name: productName(product),
      category: 'Shoes',
      status: 'active',
      needsDetails: false,
      isAvailable: true,
      price: product.price,
      quantity: 0,
      stock: 0,
      inventoryCount: 0,
      availableStock: 0,
      images: [],
      imageUrl: '',
      description: '',
      createdAt: timestamp(),
      updatedAt: timestamp(),
    });
  }
}

async function main() {
  const collectionsToClear = [
    'locations',
    'scans',
    'storeQueue',
    'pickQueue',
    'pickRequests',
    'scanQueue',
    'processedScans',
    'commands',
    'activityLog',
    'systemActivity',
    'products',
    'boxes',
  ];

  console.log('CLEANUP_START');
  console.log(`FIREBASE_PROJECT_ID = ${FIREBASE_PROJECT_ID}`);

  for (const collectionPath of collectionsToClear) {
    const deleted = await deleteCollection(collectionPath);
    console.log(`CLEANUP_DELETED ${collectionPath} = ${deleted}`);
  }

  await deleteDoc('inventory/boxes');
  await recreateLocations();
  await recreateProducts();
  await setDoc('automation/status', {
    automationStarted: false,
    sortingStrategy: '',
    currentState: 'WAIT_FOR_AUTOMATION',
    cameraBusy: false,
    beltRunning: false,
    beltBlocked: true,
    lifterBusy: false,
    currentOperation: '',
    lastError: null,
    updatedAt: timestamp(),
  });
  await addDoc('activityLog', {
    type: 'CLEANUP_DONE',
    activityType: 'CLEANUP_DONE',
    message: 'Firebase runtime data cleaned; locations and products rebuilt.',
    source: 'cleanup-script',
    sourceDevice: 'cleanup-script',
    status: 'info',
    createdAt: timestamp(),
  });
  await addDoc('systemActivity', {
    type: 'CLEANUP_DONE',
    activityType: 'CLEANUP_DONE',
    message: 'Firebase runtime data cleaned; locations and products rebuilt.',
    source: 'cleanup-script',
    sourceDevice: 'cleanup-script',
    status: 'info',
    createdAt: timestamp(),
  });

  const verification = {
    locations: (await listDocs('locations')).length,
    products: (await listDocs('products')).length,
    scans: (await listDocs('scans')).length,
    storeQueue: (await listDocs('storeQueue')).length,
    pickQueue: (await listDocs('pickQueue')).length,
    pickRequests: (await listDocs('pickRequests')).length,
    scanQueue: (await listDocs('scanQueue')).length,
    processedScans: (await listDocs('processedScans')).length,
    commands: (await listDocs('commands')).length,
    boxes: (await listDocs('boxes')).length,
    activityLog: (await listDocs('activityLog')).length,
    systemActivity: (await listDocs('systemActivity')).length,
  };
  const productIds = (await listDocs('products')).map((doc) => doc.name.split('/').at(-1));
  const expectedProductIds = new Set(INTERNAL_PRODUCT_CATALOG.map(normalizedSku));
  const randomProductIds = productIds.filter((id) => !expectedProductIds.has(id));
  const duplicateProducts = productIds.length !== new Set(productIds).size;

  console.log('CLEANUP_VERIFY');
  Object.entries(verification).forEach(([key, value]) => console.log(`${key} = ${value}`));
  console.log(`duplicateProducts = ${duplicateProducts}`);
  console.log(`randomProductIds = ${JSON.stringify(randomProductIds)}`);

  const ok =
    verification.locations === 9 &&
    verification.products === INTERNAL_PRODUCT_CATALOG.length &&
    verification.scans === 0 &&
    verification.storeQueue === 0 &&
    verification.pickQueue === 0 &&
    verification.pickRequests === 0 &&
    verification.scanQueue === 0 &&
    verification.processedScans === 0 &&
    verification.commands === 0 &&
    verification.boxes === 0 &&
    verification.activityLog <= 1 &&
    verification.systemActivity <= 1 &&
    !duplicateProducts &&
    randomProductIds.length === 0;

  if (!ok) {
    throw new Error('CLEANUP_VERIFY_FAILED');
  }
  console.log('CLEANUP_OK');
}

main().catch((error) => {
  console.error('CLEANUP_FAILED');
  console.error(error);
  process.exitCode = 1;
});
