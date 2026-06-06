import { addDoc, collection, deleteDoc, getDocs, serverTimestamp } from 'firebase/firestore';

const sampleProducts = [
  {
    brand: 'StridePro',
    model: 'XR-200',
    category: 'Running',
    size: '9 US',
    color: 'Cloud White',
    price: 129.99,
    quantity: 42,
    imageUrl: 'https://images.unsplash.com/photo-1519741495287-51247a6448c6?auto=format&fit=crop&w=900&q=80',
    description: 'Lightweight daily running shoe with responsive cushioning, breathable mesh, and durable grip for road training.',
    isAvailable: true,
  },
  {
    brand: 'StridePro',
    model: 'Aero Knit 4',
    category: 'Running',
    size: '8.5 US',
    color: 'Volt Lime',
    price: 118.0,
    quantity: 33,
    imageUrl: 'https://images.unsplash.com/photo-1460353581641-37baddab0fa2?auto=format&fit=crop&w=900&q=80',
    description: 'Breathable running shoe with a knit upper, soft heel lock, and a flexible outsole for daily miles.',
    isAvailable: true,
  },
  {
    brand: 'RunFast',
    model: 'V12',
    category: 'Sneakers',
    size: '10 US',
    color: 'Midnight Navy',
    price: 149.5,
    quantity: 28,
    imageUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=900&q=80',
    description: 'Clean street sneaker with a supportive sole, padded collar, and versatile navy finish for everyday outfits.',
    isAvailable: true,
  },
  {
    brand: 'RunFast',
    model: 'Court Classic',
    category: 'Sneakers',
    size: '9.5 US',
    color: 'White / Gum',
    price: 104.99,
    quantity: 18,
    imageUrl: 'https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?auto=format&fit=crop&w=900&q=80',
    description: 'Low-profile sneaker with a court-inspired silhouette, cushioned footbed, and easy everyday styling.',
    isAvailable: true,
  },
  {
    brand: 'TerraStep',
    model: 'Trek 7',
    category: 'Boots',
    size: '11 US',
    color: 'Forest Green',
    price: 139.0,
    quantity: 16,
    imageUrl: 'https://images.unsplash.com/photo-1503341455253-b2e53446f56b?auto=format&fit=crop&w=900&q=80',
    description: 'Rugged boot built for wet streets and light trails with reinforced panels and stable ankle support.',
    isAvailable: true,
  },
  {
    brand: 'TerraStep',
    model: 'Summit Guard',
    category: 'Boots',
    size: '10 US',
    color: 'Dark Brown',
    price: 164.5,
    quantity: 11,
    imageUrl: 'https://images.unsplash.com/photo-1608256246200-53e635b5b65f?auto=format&fit=crop&w=900&q=80',
    description: 'Weather-ready leather boot with grippy tread, padded tongue, and a reinforced toe for long wear.',
    isAvailable: true,
  },
  {
    brand: 'MetroFlex',
    model: 'U3',
    category: 'Casual',
    size: '8 US',
    color: 'Slate Gray',
    price: 115.75,
    quantity: 0,
    imageUrl: 'https://images.unsplash.com/photo-1514970893696-6b5f61d8b83f?auto=format&fit=crop&w=900&q=80',
    description: 'Minimal casual shoe with a flexible sole and soft lining for long workdays and weekend plans.',
    isAvailable: false,
  },
  {
    brand: 'MetroFlex',
    model: 'Daily Slip',
    category: 'Casual',
    size: '7.5 US',
    color: 'Sand Beige',
    price: 89.99,
    quantity: 24,
    imageUrl: 'https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=900&q=80',
    description: 'Easy slip-on casual shoe with a lightweight sole and clean profile for relaxed daily wear.',
    isAvailable: true,
  },
  {
    brand: 'StepEase',
    model: 'Pace 5',
    category: 'Sandals',
    size: '10.5 US',
    color: 'Blush Pink',
    price: 123.25,
    quantity: 21,
    imageUrl: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=80',
    description: 'Cushioned sandal with adjustable straps and a molded footbed for warm days and easy walking.',
    isAvailable: true,
  },
  {
    brand: 'StepEase',
    model: 'Coast Strap',
    category: 'Sandals',
    size: '9 US',
    color: 'Black',
    price: 74.99,
    quantity: 0,
    imageUrl: 'https://images.unsplash.com/photo-1603487742131-4160ec999306?auto=format&fit=crop&w=900&q=80',
    description: 'Durable walking sandal with adjustable straps, textured sole, and quick comfort for summer days.',
    isAvailable: false,
  },
];

async function seedProducts(db) {
  const collectionRef = collection(db, 'products');
  const promises = sampleProducts.map((product) =>
    addDoc(collectionRef, {
      ...product,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
  );

  await Promise.all(promises);
}

async function resetProducts(db) {
  const collectionRef = collection(db, 'products');
  const snapshot = await getDocs(collectionRef);
  const deletePromises = snapshot.docs.map((doc) => deleteDoc(doc.ref));
  await Promise.all(deletePromises);
}

export default seedProducts;
export { resetProducts };
