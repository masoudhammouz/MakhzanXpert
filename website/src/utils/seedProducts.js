import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { buildNormalizedSku, buildProductSlug } from './productVisibility.js';

const predefinedProducts = [
  { brand: 'NIKE', model: 'AIR FORCE 1', color: 'WHITE', size: '40', price: 120 },
  { brand: 'NIKE', model: 'AIR FORCE 1', color: 'WHITE', size: '42', price: 120 },
  { brand: 'NIKE', model: 'AIR MAX', color: 'BLACK', size: '42', price: 150 },
  { brand: 'NIKE', model: 'DUNK', color: 'BLACK WHITE', size: '41', price: 115 },
  { brand: 'ADIDAS', model: 'SAMBA', color: 'WHITE BLACK', size: '40', price: 100 },
  { brand: 'ADIDAS', model: 'SAMBA', color: 'BLACK WHITE', size: '42', price: 100 },
  { brand: 'ADIDAS', model: 'ULTRABOOST', color: 'BLACK', size: '43', price: 160 },
  { brand: 'ADIDAS', model: 'GAZELLE', color: 'BLUE', size: '41', price: 105 },
  { brand: 'PUMA', model: 'PALERMO', color: 'GREEN', size: '42', price: 95 },
  { brand: 'PUMA', model: 'SUEDE', color: 'BLACK', size: '41', price: 90 },
  { brand: 'PUMA', model: 'RS-X', color: 'WHITE', size: '43', price: 125 },
  { brand: 'PUMA', model: 'PALERMO', color: 'PINK', size: '40', price: 95 },
  { brand: 'SKECHERS', model: 'UNO', color: 'WHITE', size: '40', price: 85 },
  { brand: 'SKECHERS', model: 'UNO', color: 'BLACK', size: '42', price: 85 },
  { brand: 'SKECHERS', model: 'GO WALK', color: 'NAVY', size: '43', price: 80 },
  { brand: "SKECHERS", model: "D'LITES", color: 'WHITE', size: '41', price: 90 },
];

function productName(product) {
  return `${product.brand} ${product.model} ${product.color} Size ${product.size}`;
}

async function seedProducts(db) {
  const promises = predefinedProducts.map(async (product) => {
    const normalizedSku = buildNormalizedSku(product);
    const productRef = doc(db, 'products', normalizedSku);
    const existing = await getDoc(productRef);
    if (existing.exists()) return;

    await setDoc(productRef, {
      id: normalizedSku,
      normalizedSku,
      slug: buildProductSlug(product),
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
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  await Promise.all(promises);
}

async function resetProducts(db) {
  const collectionRef = collection(db, 'products');
  const snapshot = await getDocs(collectionRef);
  const deletePromises = snapshot.docs.map((item) => deleteDoc(item.ref));
  await Promise.all(deletePromises);
}

export default seedProducts;
export { resetProducts };
