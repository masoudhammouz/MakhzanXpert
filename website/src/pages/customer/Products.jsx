import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import ProductCard from '../../components/ProductCard.jsx';
import SearchBar from '../../components/SearchBar.jsx';
import SectionHeader from '../../components/SectionHeader.jsx';
import { db } from '../../firebase/firebase.js';

const PRODUCT_CATEGORIES = ['Sneakers', 'Running', 'Casual', 'Boots', 'Sandals'];

function getCreatedAtValue(product) {
  if (product.createdAt?.toMillis) return product.createdAt.toMillis();
  if (typeof product.createdAt === 'number') return product.createdAt;
  return 0;
}

function isProductAvailable(product) {
  return Boolean(product.isAvailable) && Number(product.quantity || 0) > 0;
}

function getProductTitle(product) {
  return product.name || [product.brand, product.model].filter(Boolean).join(' ');
}

function Products() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setSearchText(params.get('q') || '');
  }, [location.search]);

  useEffect(() => {
    async function loadProducts() {
      setLoading(true);
      setError('');

      try {
        const productsQuery = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(productsQuery);
        const items = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        setProducts(items);
      } catch (fetchError) {
        setError('Unable to load products. Please try again later.');
      } finally {
        setLoading(false);
      }
    }

    loadProducts();
  }, []);

  const filteredAndSortedProducts = useMemo(() => {
    let result = [...products];
    const term = searchText.trim().toLowerCase();

    if (term) {
      result = result.filter((product) =>
        [
          getProductTitle(product),
          product.brand,
          product.model,
          product.category,
          product.size,
          product.color,
          product.description,
        ]
          .map((value) => value?.toString().toLowerCase() || '')
          .some((value) => value.includes(term)),
      );
    }

    if (categoryFilter !== 'all') {
      result = result.filter((product) => product.category === categoryFilter);
    }

    if (availabilityFilter === 'available') {
      result = result.filter(isProductAvailable);
    } else if (availabilityFilter === 'out-of-stock') {
      result = result.filter((product) => !isProductAvailable(product));
    }

    if (sortBy === 'price-low') {
      result.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    } else if (sortBy === 'price-high') {
      result.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
    } else {
      result.sort((a, b) => getCreatedAtValue(b) - getCreatedAtValue(a));
    }

    return result;
  }, [products, searchText, categoryFilter, availabilityFilter, sortBy]);

  const handleSearchSubmit = (value) => {
    const queryParam = value.trim();
    navigate({ pathname: '/products', search: queryParam ? `?q=${encodeURIComponent(queryParam)}` : '' });
  };

  return (
    <div className="products-page">
      <section className="products-hero">
        <SectionHeader
          eyebrow="Product catalog"
          title="Real shoe inventory, ready to browse"
          description="Search by brand, model, category, size, color, or product details."
        />

        <div className="products-search-bar">
          <SearchBar
            value={searchText}
            onChange={setSearchText}
            onSubmit={handleSearchSubmit}
            placeholder="Search shoes"
            className="products-search"
          />
        </div>
      </section>

      <section className="products-filters" aria-label="Product filters">
        <div className="filter-section category-filter-bar">
          <label className="filter-section-label">Category</label>
          <div className="filter-pills">
            <button
              className={`filter-pill ${categoryFilter === 'all' ? 'active' : ''}`}
              onClick={() => setCategoryFilter('all')}
              type="button"
            >
              All
            </button>
            {PRODUCT_CATEGORIES.map((category) => (
              <button
                key={category}
                className={`filter-pill ${categoryFilter === category ? 'active' : ''}`}
                onClick={() => setCategoryFilter(category)}
                type="button"
              >
                {category}
              </button>
            ))}
          </div>
        </div>

        <div className="filters-row">
          <div className="filter-section">
            <label className="filter-section-label" htmlFor="availability-filter">Availability</label>
            <select
              id="availability-filter"
              value={availabilityFilter}
              onChange={(event) => setAvailabilityFilter(event.target.value)}
              className="sort-select"
            >
              <option value="all">All products</option>
              <option value="available">Available</option>
              <option value="out-of-stock">Out of stock</option>
            </select>
          </div>

          <div className="filter-section">
            <label className="filter-section-label" htmlFor="sort-products">Sort by</label>
            <select
              id="sort-products"
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
              className="sort-select"
            >
              <option value="newest">Newest</option>
              <option value="price-low">Price: Low to High</option>
              <option value="price-high">Price: High to Low</option>
            </select>
          </div>
        </div>
      </section>

      {loading ? (
        <LoadingState message="Loading products..." />
      ) : error ? (
        <EmptyState title="Unable to load products" description="Something went wrong while fetching the product catalog." />
      ) : filteredAndSortedProducts.length === 0 ? (
        <EmptyState title="No products found" description="Try adjusting your filters or search terms." />
      ) : (
        <div className="products-results">
          <p className="results-count">
            {filteredAndSortedProducts.length} product{filteredAndSortedProducts.length !== 1 ? 's' : ''} found
          </p>
          <div className="product-grid">
            {filteredAndSortedProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Products;
