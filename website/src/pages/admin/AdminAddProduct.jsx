import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ProductForm from '../../components/ProductForm.jsx';
import { db } from '../../firebase/firebase.js';
import { buildNormalizedSku } from '../../utils/productVisibility.js';

function AdminAddProduct() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (product) => {
    setSaving(true);
    setError('');

    try {
      const normalizedSku = product.normalizedSku || buildNormalizedSku(product);
      await setDoc(doc(db, 'products', normalizedSku), {
        ...product,
        normalizedSku,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
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
