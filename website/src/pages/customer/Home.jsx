import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import ProductCard from '../../components/ProductCard.jsx';
import SectionHeader from '../../components/SectionHeader.jsx';
import { db } from '../../firebase/firebase.js';
import { getSellableStock, isCustomerVisibleProduct, isProductAvailable } from '../../utils/productVisibility.js';

function Home() {
  const [featuredProducts, setFeaturedProducts] = useState([]);

  useEffect(() => {
    const productsQuery = query(collection(db, 'products'), orderBy('createdAt', 'desc'), limit(12));
    const unsubscribe = onSnapshot(
      productsQuery,
      (snapshot) => {
        const loadedProducts = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        loadedProducts.forEach((product) => {
          const visible = isCustomerVisibleProduct(product);
          console.info(visible ? '[PRODUCT_VISIBLE_IN_STOCK]' : '[PRODUCT_HIDDEN_OUT_OF_STOCK]', {
            productId: product.id,
            stock: getSellableStock(product),
            inStock: product.inStock === true,
            available: isProductAvailable(product),
            surface: 'home-featured',
          });
        });
        setFeaturedProducts(loadedProducts.filter(isCustomerVisibleProduct).slice(0, 4));
      },
      () => setFeaturedProducts([]),
    );

    return unsubscribe;
  }, []);

  return (
    <div className="home-page ecommerce">
      {/* Hero Section */}
      <section className="hero-section ecommerce-hero">
        <div className="hero-copy">
          <span className="eyebrow">Curated shoe collection</span>
          <h1>Find Your Next Pair</h1>
          <p className="hero-description">
            Discover premium shoes for every occasion. From running and casual to boots and more—all in stock and ready to ship.
          </p>

          <div className="hero-actions">
            <Link to="/products" className="button button-primary hero-button">
              Browse All Shoes
            </Link>
            <Link to="/products" className="button button-secondary hero-button">
              View New Arrivals
            </Link>
          </div>
        </div>

        <div className="hero-image-section">
          <div className="hero-image-placeholder card">
            <span className="hero-image-emoji">👟</span>
          </div>

          <div className="floating-badge floating-badge-1 card">
            <p className="badge-label">Featured</p>
            <p className="badge-value">{featuredProducts.length}</p>
          </div>
          <div className="floating-badge floating-badge-2 card">
            <p className="badge-label">Fast Ship</p>
            <p className="badge-value">24h</p>
          </div>
        </div>
      </section>

      {/* Featured Categories */}
      <section className="categories-section">
        <SectionHeader
          eyebrow="Shop by style"
          title="Find shoes for every moment"
        />

        <div className="categories-grid">
          <Link to="/products" className="category-card card">
            <div className="category-icon">🏃</div>
            <h3>Running Shoes</h3>
            <p>Performance and comfort for active runners</p>
          </Link>
          <Link to="/products" className="category-card card">
            <div className="category-icon">👟</div>
            <h3>Sneakers</h3>
            <p>Casual style for everyday wear</p>
          </Link>
          <Link to="/products" className="category-card card">
            <div className="category-icon">🥾</div>
            <h3>Boots</h3>
            <p>Durable and stylish for any weather</p>
          </Link>
          <Link to="/products" className="category-card card">
            <div className="category-icon">🧘</div>
            <h3>Casual Loafers</h3>
            <p>Relaxed elegance for everyday comfort</p>
          </Link>
        </div>
      </section>

      {/* Featured Products */}
      {featuredProducts.length > 0 && (
        <section className="featured-products-section">
          <SectionHeader
            eyebrow="Customer favorites"
            title="Best sellers this season"
          />

          <div className="featured-products-grid">
            {featuredProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>

          <div className="view-all-products">
            <Link to="/products" className="button button-secondary">
              View All Products
            </Link>
          </div>
        </section>
      )}

      {/* Customer Benefits */}
      <section className="benefits-section">
        <SectionHeader
          eyebrow="Why shop with us"
          title="We make shoe shopping easy"
        />

        <div className="benefits-grid">
          <article className="benefit-card">
            <div className="benefit-icon">✓</div>
            <h3>Always in Stock</h3>
            <p>Real-time availability means the shoes you want are ready to ship today.</p>
          </article>
          <article className="benefit-card">
            <div className="benefit-icon">⚡</div>
            <h3>Fast Shipping</h3>
            <p>Most orders ship within 24 hours. Get your shoes quickly and reliably.</p>
          </article>
          <article className="benefit-card">
            <div className="benefit-icon">🔍</div>
            <h3>Easy to Find</h3>
            <p>Search by style, size, or color. Our organized collection makes shopping simple.</p>
          </article>
          <article className="benefit-card">
            <div className="benefit-icon">💯</div>
            <h3>Quality Guaranteed</h3>
            <p>Every pair is inspected and ready to wear. Free returns if they don't fit perfectly.</p>
          </article>
        </div>
      </section>

      {/* New Arrivals Banner */}
      <section className="promo-banner card">
        <div className="promo-content">
          <h2>New Arrivals Just Landed</h2>
          <p>Check out the latest styles and trends in our collection.</p>
          <Link to="/products" className="button button-primary">
            See What's New
          </Link>
        </div>
      </section>
    </div>
  );
}

export default Home;
