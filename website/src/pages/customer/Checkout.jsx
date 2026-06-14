import { collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../../context/CartContext.jsx';
import { db } from '../../firebase/firebase.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { buildProductSlug, getSellableStock, isCustomerPurchasableProduct, isProductAvailable } from '../../utils/productVisibility.js';

function getProductTitle(product) {
  return product.name || [product.brand, product.model].filter(Boolean).join(' ') || 'Shoe product';
}

function buildProductKey(product) {
  return ['brand', 'model', 'color', 'size']
    .map((field) => String(product[field] || '').trim().toUpperCase())
    .join('|');
}

function Checkout() {
  const navigate = useNavigate();
  const { items, subtotal, clearCart } = useCart();
  const [form, setForm] = useState({
    customerName: '',
    customerPhone: '',
    customerAddress: '',
    notes: '',
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const validate = () => {
    const nextErrors = {};
    if (!form.customerName.trim()) nextErrors.customerName = 'Name is required';
    if (!form.customerPhone.trim()) nextErrors.customerPhone = 'Phone is required';
    if (!form.customerAddress.trim()) nextErrors.customerAddress = 'Address is required';
    return nextErrors;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validate();
    setErrors(nextErrors);
    setSubmitError('');

    if (Object.keys(nextErrors).length > 0) return;
    if (items.length === 0) {
      setSubmitError('Your cart is empty.');
      return;
    }

    setSubmitting(true);

    try {
      const orderItems = items.map((item) => ({
        productId: item.id,
        slug: item.slug || buildProductSlug(item),
        brand: item.brand || '',
        model: item.model || item.name || '',
        category: item.category || '',
        size: item.size || '',
        color: item.color || '',
        productKey: item.productKey || buildProductKey(item),
        price: Number(item.price || 0),
        quantity: Number(item.quantity || 0),
        imageUrl: item.imageUrl || '',
      }));

      await runTransaction(db, async (transaction) => {
        const productRefs = items.map((item) => doc(db, 'products', item.id));
        const productSnapshots = await Promise.all(productRefs.map((ref) => transaction.get(ref)));

        productSnapshots.forEach((snapshot, index) => {
          const cartItem = items[index];
          if (!snapshot.exists()) {
            throw new Error(`${getProductTitle(cartItem)} is no longer available.`);
          }

          const productData = { id: snapshot.id, ...snapshot.data() };
          const availableStock = Number(productData.availableStock ?? 0);
          const availableQuantity = Number(productData.availableQuantity ?? 0);
          const currentQuantity = getSellableStock(productData);
          const orderedQuantity = Number(cartItem.quantity || 0);
          const valid = isProductAvailable(productData) &&
            isCustomerPurchasableProduct(productData) &&
            availableStock > 0 &&
            availableQuantity > 0 &&
            currentQuantity >= orderedQuantity;

          console.info('[CHECKOUT_STOCK_VALIDATION]', {
            productId: productData.id,
            valid,
            availableStock,
            availableQuantity,
            sellableStock: currentQuantity,
            cartQuantity: orderedQuantity,
            surface: 'checkout',
          });

          if (!valid && (availableStock <= 0 || availableQuantity <= 0 || !isProductAvailable(productData))) {
            throw new Error(`${getProductTitle(cartItem)} is not available for checkout.`);
          }

          if (currentQuantity < orderedQuantity) {
            throw new Error(`Only ${currentQuantity} left for ${getProductTitle(cartItem)}.`);
          }

          if (!valid) {
            throw new Error(`${getProductTitle(cartItem)} is not available for checkout.`);
          }
        });

        const orderRef = doc(collection(db, 'orders'));
        const orderId = `ORD-${Date.now()}`;
        transaction.set(orderRef, {
          orderId,
          customerName: form.customerName.trim(),
          customerPhone: form.customerPhone.trim(),
          customerAddress: form.customerAddress.trim(),
          notes: form.notes.trim(),
          items: orderItems,
          totalPrice: Number(subtotal || 0),
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });

      clearCart();
      navigate('/order-success');
    } catch (error) {
      setSubmitError(error.message || 'Unable to place order. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className="checkout-page">
        <section className="empty-state card">
          <h2>Your cart is empty</h2>
          <p className="section-description">Add products to your cart before checkout.</p>
          <Link to="/products" className="button button-primary">Browse Products</Link>
        </section>
      </div>
    );
  }

  return (
    <div className="checkout-page">
      <section className="checkout-form-panel">
        <div>
          <p className="section-eyebrow">Checkout</p>
          <h1>Customer Details</h1>
        </div>

        <form className="checkout-form" onSubmit={handleSubmit}>
          {submitError && <p className="admin-form-error">{submitError}</p>}

          <label>
            Name
            <input name="customerName" value={form.customerName} onChange={handleChange} />
            {errors.customerName && <span>{errors.customerName}</span>}
          </label>

          <label>
            Phone
            <input name="customerPhone" value={form.customerPhone} onChange={handleChange} />
            {errors.customerPhone && <span>{errors.customerPhone}</span>}
          </label>

          <label>
            Address
            <textarea name="customerAddress" value={form.customerAddress} onChange={handleChange} rows="4" />
            {errors.customerAddress && <span>{errors.customerAddress}</span>}
          </label>

          <label>
            Notes optional
            <textarea name="notes" value={form.notes} onChange={handleChange} rows="3" />
          </label>

          <div className="checkout-actions">
            <Link to="/cart" className="button button-secondary">Back to Cart</Link>
            <button className="button button-primary" type="submit" disabled={submitting}>
              {submitting ? 'Placing Order...' : 'Place Order'}
            </button>
          </div>
        </form>
      </section>

      <aside className="checkout-summary-panel">
        <p className="section-eyebrow">Order summary</p>
        <div className="checkout-summary-items">
          {items.map((item) => (
            <div className="checkout-summary-row" key={item.id}>
              <div>
                <p className="inventory-product-name">{getProductTitle(item)}</p>
                <p className="orders-customer-meta">Qty {Number(item.quantity || 0)} - {formatCurrency(item.price)}</p>
              </div>
              <p>{formatCurrency(Number(item.price || 0) * Number(item.quantity || 0))}</p>
            </div>
          ))}
        </div>
        <div className="checkout-total-row">
          <p>Total</p>
          <p>{formatCurrency(subtotal)}</p>
        </div>
      </aside>
    </div>
  );
}

export default Checkout;
