import { Link } from 'react-router-dom';
import placeholderImage from '../assets/placeholder-shoe.svg';
import { formatCurrency } from '../utils/formatCurrency.js';
import { isCustomerPurchasableProduct } from '../utils/productVisibility.js';

function getProductTitle(product) {
  return product.name || [product.brand, product.model].filter(Boolean).join(' ') || 'Shoe product';
}

function isProductAvailable(product) {
  return isCustomerPurchasableProduct(product);
}

export default function ProductCard({ product }) {
  const title = getProductTitle(product);
  const available = isProductAvailable(product);
  const badgeClass = available ? 'status-badge status-available' : 'status-badge status-unavailable';

  return (
    <article className="product-card">
      <Link to={`/product/${product.id}`} className="product-card-media" aria-label={`View ${title}`}>
        <img
          src={product.imageUrl || placeholderImage}
          alt={title}
          loading="lazy"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = placeholderImage;
          }}
        />
      </Link>

      <div className="product-card-body">
        <div className="product-card-badges">
          <span className="brand-badge">{product.brand || 'Brand'}</span>
          <span className="category-badge">{product.category || 'Uncategorized'}</span>
          <span className={badgeClass}>{available ? 'Available' : 'Out of stock'}</span>
        </div>

        <div>
          <h3>
            <Link to={`/product/${product.id}`} className="product-title-link">{title}</Link>
          </h3>
          <p className="product-meta">{product.model || title}</p>
        </div>

        {product.description && <p className="product-card-description">{product.description}</p>}

        <div className="product-card-footer">
          <div>
            <p className="spec-label">Size</p>
            <p className="spec-value">{product.size || '-'}</p>
          </div>
          <div>
            <p className="spec-label">Color</p>
            <p className="spec-value">{product.color || '-'}</p>
          </div>
          <div>
            <p className="spec-label">Price</p>
            <p className="spec-value price-value">{formatCurrency(product.price)}</p>
          </div>
        </div>

        <Link to={`/product/${product.id}`} className="button button-secondary product-action" aria-label={`View details for ${title}`}>
          View Details
        </Link>
      </div>
    </article>
  );
}
