import { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import ProductCard from '../../components/ProductCard.jsx';
import { db } from '../../firebase/firebase.js';
import placeholderImage from '../../assets/placeholder-shoe.svg';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { useNavigate, useParams } from 'react-router-dom';
import { useCart } from '../../context/CartContext.jsx';
import {
  getSellableStock,
  isCustomerPurchasableProduct,
  isCustomerVisibleProduct,
  isProductAvailable,
  isPublishedProduct,
} from '../../utils/productVisibility.js';

function getProductTitle(product) {
  return product.name || [product.brand, product.model].filter(Boolean).join(' ') || 'Shoe product';
}

export default function ProductDetails() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { addToCart } = useCart();
  const [product, setProduct] = useState(null);
  const [allProducts, setAllProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!slug) return undefined;

    setLoading(true);
    setError('');

    const productQuery = query(collection(db, 'products'), where('slug', '==', slug), limit(1));
    const productsQuery = query(collection(db, 'products'), orderBy('createdAt', 'desc'));

    const unsubscribeProduct = onSnapshot(
      productQuery,
      (productResult) => {
        const productSnap = productResult.docs[0];
        if (!productSnap) {
          setProduct(null);
          setLoading(false);
          return;
        }

        const loadedProduct = { id: productSnap.id, ...productSnap.data() };
        if (isPublishedProduct(loadedProduct)) {
          const visible = isCustomerVisibleProduct(loadedProduct);
          console.info(visible ? '[PRODUCT_VISIBLE_IN_STOCK]' : '[PRODUCT_HIDDEN_OUT_OF_STOCK]', {
            productId: loadedProduct.id,
            stock: getSellableStock(loadedProduct),
            inStock: loadedProduct.inStock === true,
            available: isProductAvailable(loadedProduct),
          });
        }
        if (isCustomerVisibleProduct(loadedProduct)) {
          console.info('[CLIENT_PRODUCT_STOCK_VISIBLE]', {
            productId: loadedProduct.id,
            stock: getSellableStock(loadedProduct),
            inStock: loadedProduct.inStock === true,
          });
        }
        setProduct(isPublishedProduct(loadedProduct) ? loadedProduct : null);
        setLoading(false);
      },
      () => {
        setError('Unable to load product.');
        setLoading(false);
      },
    );

    const unsubscribeProducts = onSnapshot(
      productsQuery,
      (productsSnap) => {
        setAllProducts(productsSnap.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .filter(isCustomerVisibleProduct));
      },
      () => {
        setError('Unable to load product.');
      },
    );

    return () => {
      unsubscribeProduct();
      unsubscribeProducts();
    };
  }, [slug]);

  const relatedProducts = useMemo(() => {
    if (!product?.category) return [];
    return allProducts
      .filter((item) => item.id !== product.id && item.category === product.category)
      .slice(0, 4);
  }, [allProducts, product]);

  const sameBrandProducts = useMemo(() => {
    if (!product?.brand) return [];
    return allProducts
      .filter((item) => item.id !== product.id && item.brand === product.brand)
      .slice(0, 4);
  }, [allProducts, product]);

  if (loading) return <LoadingState message="Loading product..." />;

  if (error) return <EmptyState title="Error loading product" description={error} />;

  if (!product) return <EmptyState title="Product not found" description="This product does not exist or is no longer available." />;

  const title = getProductTitle(product);
  const available = isProductAvailable(product) && isCustomerPurchasableProduct(product);

  const handleAddToCart = () => {
    if (!available) return;
    addToCart(product);
  };

  const handleBuyNow = () => {
    if (!available) return;
    addToCart(product);
    navigate('/cart');
  };

  return (
    <div className="product-details-page">
      <section className="product-details">
        <div className="product-details-grid">
          <div className="product-image-panel">
            <img
              src={product.imageUrl || placeholderImage}
              alt={title}
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = placeholderImage;
              }}
            />
          </div>

          <div className="product-info-panel">
            <div className="product-card-badges">
              <span className="category-badge">{product.category || 'Uncategorized'}</span>
              <span className={`status-badge ${available ? 'status-available' : 'status-unavailable'}`}>
                {available ? 'Available' : 'Out of stock'}
              </span>
            </div>

            <div>
              <p className="product-brand">{product.brand || 'Brand'}</p>
              <h1 className="product-title">{title}</h1>
              <p className="product-meta large">{[product.model, product.color].filter(Boolean).join(' / ')}</p>
              {!available && <p className="admin-form-error">Product currently unavailable</p>}
            </div>

            <div className="product-price">{formatCurrency(product.price)}</div>

            <div className="product-specs large-specs">
              <div>
                <p className="spec-label">Category</p>
                <p className="spec-value">{product.category || '-'}</p>
              </div>
              <div>
                <p className="spec-label">Size</p>
                <p className="spec-value">{product.size || '-'}</p>
              </div>
              <div>
                <p className="spec-label">Color</p>
                <p className="spec-value">{product.color || '-'}</p>
              </div>
              <div>
                <p className="spec-label">Quantity available</p>
                <p className="spec-value">{getSellableStock(product)}</p>
              </div>
              <div>
                <p className="spec-label">Availability</p>
                <p className="spec-value">{available ? 'Available' : 'Out of stock'}</p>
              </div>
            </div>

            <div className="product-description-panel">
              <h2>About this product</h2>
              <p>{product.description || 'No description is available for this product yet.'}</p>
            </div>

            <div className="product-actions">
              <button className="button button-primary" type="button" onClick={handleAddToCart} disabled={!available}>
                Add to Cart
              </button>
              <button className="button button-secondary" type="button" onClick={handleBuyNow} disabled={!available}>
                Buy Now
              </button>
            </div>
          </div>
        </div>
      </section>

      {relatedProducts.length > 0 && (
        <section className="product-recommendations">
          <div className="recommendations-header">
            <p className="section-eyebrow">Related products</p>
            <h2>More from {product.category}</h2>
          </div>
          <div className="product-grid compact-grid">
            {relatedProducts.map((item) => (
              <ProductCard key={item.id} product={item} />
            ))}
          </div>
        </section>
      )}

      {sameBrandProducts.length > 0 && (
        <section className="product-recommendations">
          <div className="recommendations-header">
            <p className="section-eyebrow">Same brand</p>
            <h2>More by {product.brand}</h2>
          </div>
          <div className="product-grid compact-grid">
            {sameBrandProducts.map((item) => (
              <ProductCard key={item.id} product={item} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
