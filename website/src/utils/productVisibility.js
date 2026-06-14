export function normalizeSkuPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

export function buildNormalizedSku(product) {
  return ['brand', 'model', 'color', 'size']
    .map((field) => normalizeSkuPart(product?.[field]))
    .join('_');
}

export function normalizeSlugPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

export function buildProductSlug(product) {
  return ['brand', 'model', 'color', 'size']
    .map((field) => normalizeSlugPart(product?.[field]))
    .join('-');
}

export function isDraftProduct(product) {
  return Boolean(product?.needsDetails) || ['draft', 'pending_details'].includes(product?.status);
}

export function isPublishedProduct(product) {
  return Boolean(product) && product.status === 'active' && !isDraftProduct(product);
}

export function getSellableStock(product) {
  return Number(product?.availableStock ?? product?.availableQuantity ?? product?.stock ?? 0);
}

export const isProductAvailable = (product) => (
  (product?.inStock === true) &&
  ((product?.availableStock ?? product?.availableQuantity ?? product?.stock ?? 0) > 0)
);

export function isCustomerVisibleProduct(product) {
  return (
    isPublishedProduct(product) &&
    product?.price !== null &&
    product?.price !== undefined &&
    isProductAvailable(product)
  );
}

export function isCustomerPurchasableProduct(product) {
  return isCustomerVisibleProduct(product) && Number(product?.price || 0) > 0;
}
