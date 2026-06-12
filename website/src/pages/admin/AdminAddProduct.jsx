import { addDoc, collection, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ProductForm from '../../components/ProductForm.jsx';
import { db } from '../../firebase/firebase.js';
import { buildNormalizedSku, buildProductSlug } from '../../utils/productVisibility.js';

async function logProductActivity(type, message) {
  const data = {
    type,
    activityType: type,
    message,
    source: 'website',
    sourceDevice: 'admin',
    status: 'info',
    createdAt: serverTimestamp(),
  };
  await Promise.all([
    addDoc(collection(db, 'systemActivity'), data),
    addDoc(collection(db, 'activityLog'), data),
  ]);
}

function AdminAddProduct() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (product) => {
    setSaving(true);
    setError('');

    try {
      const normalizedSku = product.normalizedSku || buildNormalizedSku(product);
      const slug = product.slug || buildProductSlug(product);
      const productRef = doc(db, 'products', normalizedSku);
      const existingProduct = await getDoc(productRef);

      if (existingProduct.exists()) {
        const shouldUpdate = window.confirm('Product already exists. Update this product details instead?');
        await logProductActivity('DUPLICATE_PRODUCT_PREVENTED', `${normalizedSku} already exists from manual admin entry.`);
        if (!shouldUpdate) {
          setError('Product already exists. No duplicate was created.');
          return;
        }
      }

      await setDoc(doc(db, 'products', normalizedSku), {
        ...product,
        id: normalizedSku,
        normalizedSku,
        slug,
        createdAt: existingProduct.exists() ? existingProduct.data().createdAt || serverTimestamp() : serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      if (product.status === 'active' && !product.needsDetails) {
        await logProductActivity('PRODUCT_DETAILS_COMPLETED', `${normalizedSku} saved as active from admin.`);
      }
      navigate('/admin/inventory');
    } catch {
      setError('Unable to add product. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProductForm
      mode="add"
      onSubmit={handleSubmit}
      saving={saving}
      error={error}
    />
  );
}

export default AdminAddProduct;
