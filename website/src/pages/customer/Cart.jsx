import { doc, getDoc } from 'firebase/firestore';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import placeholderImage from '../../assets/placeholder-shoe.svg';
import { useCart } from '../../context/CartContext.jsx';
import { db } from '../../firebase/firebase.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { buildProductSlug, getSellableStock, isProductAvailable } from '../../utils/productVisibility.js';

function getProductTitle(product) {
  return product.name || [product.brand, product.model].filter(Boolean).join(' ') || 'Shoe product';
}

export default function Cart() {
  const navigate = useNavigate();
  const { items, increaseQuantity, decreaseQuantity, removeFromCart, subtotal, clearCart } = useCart();
  const [stockError, setStockError] = useState('');
  const [validatingStock, setValidatingStock] = useState(false);

  const handleCheckout = async () => {
    setStockError('');
    setValidatingStock(true);

    try {
      const productChecks = await Promise.all(items.map(async (item) => {
        const snapshot = await getDoc(doc(db, 'products', item.id));
        const product = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
        const availableStock = Number(product?.availableStock ?? 0);
        const availableQuantity = Number(product?.availableQuantity ?? 0);
        const sellableStock = getSellableStock(product);
        const valid = Boolean(product) &&
          isProductAvailable(product) &&
          availableStock > 0 &&
          availableQuantity > 0 &&
          sellableStock >= Number(item.quantity || 0);

        console.info('[CHECKOUT_STOCK_VALIDATION]', {
          productId: item.id,
          valid,
          availableStock,
          availableQuantity,
          sellableStock,
          cartQuantity: Number(item.quantity || 0),
          surface: 'cart',
        });

        return { item, product, valid, availableStock, availableQuantity, sellableStock };
      }));

      const invalidItems = productChecks.filter((check) => !check.product || !isProductAvailable(check.product) || check.availableStock <= 0 || check.availableQuantity <= 0);
      invalidItems.forEach((check) => removeFromCart(check.item.id));

      if (invalidItems.length > 0) {
        setStockError('Some products are no longer available and were removed from your cart.');
        return;
      }

      const insufficientItem = productChecks.find((check) => check.sellableStock < Number(check.item.quantity || 0));
      if (insufficientItem) {
        setStockError(`Only ${insufficientItem.sellableStock} left for ${getProductTitle(insufficientItem.item)}.`);
        return;
      }

      navigate('/checkout');
    } catch {
      setStockError('Unable to validate stock. Please try again.');
    } finally {
      setValidatingStock(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className="cart-page">
        <section className="empty-state card">
          <h2>Your cart is empty</h2>
          <p className="section-description">Add shoes from the product details page to get started.</p>
          <Link to="/products" className="button button-primary">
            Browse Products
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="cart-page">
      <section className="cart card">
        <div className="cart-header">
          <div>
            <p className="section-eyebrow">Cart foundation</p>
            <h1>Your Cart</h1>
          </div>
          <button className="button button-secondary" type="button" onClick={clearCart}>
            Clear Cart
          </button>
        </div>

        {stockError && <p className="admin-form-error">{stockError}</p>}

        <div className="cart-items">
          {items.map((item) => {
            const title = getProductTitle(item);
            const itemSubtotal = Number(item.price || 0) * Number(item.quantity || 0);
            const productUrl = `/products/${item.slug || buildProductSlug(item)}`;

            return (
              <article key={item.id} className="cart-item">
                <Link to={productUrl} className="cart-item-media" aria-label={`View ${title}`}>
                  <img
                    src={item.imageUrl || placeholderImage}
                    alt={title}
                    onError={(event) => {
                      event.currentTarget.onerror = null;
                      event.currentTarget.src = placeholderImage;
                    }}
                  />
                </Link>

                <div className="cart-item-body">
                  <p className="product-brand">{item.brand || 'Brand'}</p>
                  <h2>
                    <Link to={productUrl}>{title}</Link>
                  </h2>
                  <p className="product-meta">{item.model || title}</p>

                  <div className="cart-item-specs">
                    <div>
                      <p className="spec-label">Size</p>
                      <p className="spec-value">{item.size || '-'}</p>
                    </div>
                    <div>
                      <p className="spec-label">Color</p>
                      <p className="spec-value">{item.color || '-'}</p>
                    </div>
                    <div>
                      <p className="spec-label">Price</p>
                      <p className="spec-value price-value">{formatCurrency(item.price)}</p>
                    </div>
                  </div>

                  <div className="cart-qty-controls" aria-label={`Quantity controls for ${title}`}>
                    <button type="button" className="icon-button" onClick={() => decreaseQuantity(item.id)} aria-label="Decrease quantity">
                      -
                    </button>
                    <span className="qty-value">{item.quantity}</span>
                    <button type="button" className="icon-button" onClick={() => increaseQuantity(item.id)} aria-label="Increase quantity">
                      +
                    </button>
                  </div>

                  <button className="button button-secondary cart-remove-button" type="button" onClick={() => removeFromCart(item.id)}>
                    Remove
                  </button>
                </div>

                <div className="cart-item-subtotal">
                  <p className="spec-label">Subtotal</p>
                  <p className="spec-value">{formatCurrency(itemSubtotal)}</p>
                </div>
              </article>
            );
          })}
        </div>

        <div className="cart-footer">
          <div>
            <p className="spec-label">Total</p>
            <p className="cart-total">{formatCurrency(subtotal)}</p>
          </div>

          <div className="cart-actions">
            <Link to="/products" className="button button-secondary">
              Continue Shopping
            </Link>
            <button className="button button-primary" type="button" onClick={handleCheckout} disabled={validatingStock}>
              {validatingStock ? 'Checking Stock...' : 'Checkout'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
