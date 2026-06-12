import { addDoc, collection, doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import ProductForm from '../../components/ProductForm.jsx';
import { db } from '../../firebase/firebase.js';
import { buildProductSlug } from '../../utils/productVisibility.js';

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

function AdminEditProduct() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadProduct() {
      setLoading(true);
      setError('');

      try {
        const productRef = doc(db, 'products', id);
        const snapshot = await getDoc(productRef);

        if (!snapshot.exists()) {
          setProduct(null);
        } else {
          setProduct({ id: snapshot.id, ...snapshot.data() });
        }
      } catch {
        setError('Unable to load product for editing.');
      } finally {
        setLoading(false);
      }
    }

    if (id) loadProduct();
  }, [id]);

  const handleSubmit = async (updatedProduct) => {
    setSaving(true);
    setError('');

    try {
      const nextNeedsDetails = !updatedProduct.isAvailable;
      const nextStatus = updatedProduct.isAvailable ? 'active' : 'pending_details';
      await updateDoc(doc(db, 'products', id), {
        ...updatedProduct,
        id,
        normalizedSku: product.normalizedSku || id,
        slug: updatedProduct.slug || buildProductSlug(updatedProduct),
        needsDetails: nextNeedsDetails,
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      if (nextStatus === 'active' && !nextNeedsDetails) {
        await logProductActivity('PRODUCT_DETAILS_COMPLETED', `${id} completed and activated.`);
      }
      navigate('/admin/inventory');
    } catch {
      setError('Unable to update product. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState message="Loading product..." />;
  if (error && !product) return <EmptyState title="Unable to edit product" description={error} />;
  if (!product) return <EmptyState title="Product not found" description="This product does not exist or may have been deleted." />;

  return (
    <ProductForm
      mode="edit"
      initialProduct={product}
      onSubmit={handleSubmit}
      saving={saving}
      error={error}
    />
  );
}

export default AdminEditProduct;
