import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ProductForm from '../../components/ProductForm.jsx';
import { db } from '../../firebase/firebase.js';

function AdminAddProduct() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (product) => {
    setSaving(true);
    setError('');

    try {
      await addDoc(collection(db, 'products'), {
        ...product,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
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
