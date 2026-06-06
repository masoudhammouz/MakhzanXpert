import { Link, useNavigate } from 'react-router-dom';
import placeholderImage from '../../assets/placeholder-shoe.svg';
import { useCart } from '../../context/CartContext.jsx';
import { formatCurrency } from '../../utils/formatCurrency.js';

function getProductTitle(product) {
  return product.name || [product.brand, product.model].filter(Boolean).join(' ') || 'Shoe product';
}

export default function Cart() {
  const navigate = useNavigate();
  const { items, increaseQuantity, decreaseQuantity, removeFromCart, subtotal, clearCart } = useCart();

  const handleCheckout = () => {
    navigate('/checkout');
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

        <div className="cart-items">
          {items.map((item) => {
            const title = getProductTitle(item);
            const itemSubtotal = Number(item.price || 0) * Number(item.quantity || 0);

            return (
              <article key={item.id} className="cart-item">
                <Link to={`/product/${item.id}`} className="cart-item-media" aria-label={`View ${title}`}>
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
                    <Link to={`/product/${item.id}`}>{title}</Link>
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
            <button className="button button-primary" type="button" onClick={handleCheckout}>
              Checkout
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
