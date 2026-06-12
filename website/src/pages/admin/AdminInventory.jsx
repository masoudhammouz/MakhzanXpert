import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDocs, orderBy, query } from 'firebase/firestore';
import { Link, useNavigate } from 'react-router-dom';
import EmptyState from '../../components/EmptyState.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import placeholderImage from '../../assets/placeholder-shoe.svg';
import { db } from '../../firebase/firebase.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { getSellableStock, isDraftProduct } from '../../utils/productVisibility.js';

const AVAILABILITY_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Available', value: 'available' },
  { label: 'Out of stock', value: 'out-of-stock' },
  { label: 'Needs details', value: 'needs-details' },
];

function getProductTitle(product) {
  return product.name || [product.brand, product.model].filter(Boolean).join(' ') || 'Shoe product';
}

function isAvailable(product) {
  return Boolean(product.isAvailable) && !isDraftProduct(product) && getSellableStock(product) > 0;
}

function getInventoryStock(product) {
  if (product?.stock !== undefined && product?.stock !== null) {
    return Number(product.stock || 0);
  }
  return Number(product?.quantity || 0);
}

function getStatus(product) {
  if (isDraftProduct(product)) return { label: 'Needs details', className: 'status-low-stock' };
  const quantity = getInventoryStock(product);
  if (!isAvailable(product)) return { label: 'Out of stock', className: 'status-unavailable' };
  if (quantity <= 3) return { label: 'Low stock', className: 'status-low-stock' };
  return { label: 'Available', className: 'status-available' };
}

function AdminInventory() {
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [brandFilter, setBrandFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');

  const loadProducts = async () => {
    setLoading(true);
    setError('');

    try {
      const productsQuery = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(productsQuery);
      setProducts(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
    } catch {
      setError('Unable to load inventory products.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const categories = useMemo(
    () => ['all', ...new Set(products.map((product) => product.category).filter(Boolean))],
    [products],
  );

  const brands = useMemo(
    () => ['all', ...new Set(products.map((product) => product.brand).filter(Boolean))],
    [products],
  );

  const summary = useMemo(() => {
    const totalProducts = products.length;
    const totalStock = products.reduce((sum, product) => sum + getInventoryStock(product), 0);
    const lowStockItems = products.filter((product) => getInventoryStock(product) > 0 && getInventoryStock(product) <= 3).length;
    const outOfStockItems = products.filter((product) => getInventoryStock(product) === 0 && !isDraftProduct(product)).length;
    const needsDetailsItems = products.filter(isDraftProduct).length;

    return { totalProducts, totalStock, lowStockItems, outOfStockItems, needsDetailsItems };
  }, [products]);

  const filteredProducts = useMemo(() => {
    const term = searchText.trim().toLowerCase();

    return products.filter((product) => {
      const matchesSearch = term
        ? [
          getProductTitle(product),
          product.brand,
          product.model,
          product.category,
          product.size,
          product.color,
          product.location,
        ]
          .map((value) => value?.toString().toLowerCase() || '')
          .some((value) => value.includes(term))
        : true;
      const matchesCategory = categoryFilter === 'all' || product.category === categoryFilter;
      const matchesBrand = brandFilter === 'all' || product.brand === brandFilter;
      const matchesAvailability =
        availabilityFilter === 'all' ||
        (availabilityFilter === 'available' && isAvailable(product)) ||
        (availabilityFilter === 'out-of-stock' && !isAvailable(product) && !isDraftProduct(product)) ||
        (availabilityFilter === 'needs-details' && isDraftProduct(product));

      return matchesSearch && matchesCategory && matchesBrand && matchesAvailability;
    });
  }, [availabilityFilter, brandFilter, categoryFilter, products, searchText]);

  const pendingDetailsProducts = useMemo(
    () => products.filter(isDraftProduct),
    [products],
  );

  const handleView = (product) => {
    alert(`Viewing ${getProductTitle(product)} is a placeholder action.`);
  };

  const handleEdit = (product) => {
    navigate(`/admin/inventory/edit/${product.id}`);
  };

  const handleDelete = async (product) => {
    const confirmed = window.confirm(`Delete ${getProductTitle(product)} from inventory?`);
    if (!confirmed) return;

    try {
      await deleteDoc(doc(db, 'products', product.id));
      setProducts((current) => current.filter((item) => item.id !== product.id));
    } catch {
      setError('Unable to delete product. Please try again.');
    }
  };

  return (
    <div className="admin-inventory-page">
      <section className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Inventory management</p>
          <h1>Product Inventory</h1>
          <p>Manage catalog stock visibility, availability, and warehouse-ready product data.</p>
        </div>
        <Link to="/admin/inventory/add" className="button button-primary">
          Add Product
        </Link>
      </section>

      <section className="inventory-summary-grid" aria-label="Inventory summary">
        <article className="admin-summary-card">
          <p className="metric-label">Total Products</p>
          <p className="metric-value">{summary.totalProducts}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Total Stock</p>
          <p className="metric-value">{summary.totalStock}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Low Stock Items</p>
          <p className="metric-value">{summary.lowStockItems}</p>
          <p className="metric-note">Quantity less than or equal to 3.</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Out of Stock Items</p>
          <p className="metric-value">{summary.outOfStockItems}</p>
        </article>
        <article className="admin-summary-card">
          <p className="metric-label">Needs Details</p>
          <p className="metric-value">{summary.needsDetailsItems}</p>
        </article>
      </section>

      {pendingDetailsProducts.length > 0 && (
        <section className="admin-inventory-panel pending-details-panel">
          <div className="section-header">
            <div>
              <h2>Pending Details</h2>
              <p>Products scanned from labels that need price, category, images, and description before publishing.</p>
            </div>
          </div>

          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Size</th>
                  <th>Color</th>
                  <th>Quantity</th>
                  <th>Available</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingDetailsProducts.map((product) => (
                  <tr key={product.id}>
                    <td className="inventory-product-name">{getProductTitle(product)}</td>
                    <td>{product.normalizedSku || product.id}</td>
                    <td>{product.size || '-'}</td>
                    <td>{product.color || '-'}</td>
                    <td>{Number(product.quantity || 0)}</td>
                    <td>{getSellableStock(product)}</td>
                    <td>
                      <div className="inventory-actions">
                        <button type="button" onClick={() => handleEdit(product)}>Complete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="admin-inventory-panel">
        <div className="inventory-toolbar">
          <div className="admin-search-field">
            <label htmlFor="inventory-search">Search products</label>
            <input
              id="inventory-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Brand, model, name, color, category"
              type="search"
            />
          </div>

          <div className="inventory-filters">
            <label>
              Category
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                {categories.map((category) => (
                  <option key={category} value={category}>{category === 'all' ? 'All' : category}</option>
                ))}
              </select>
            </label>
            <label>
              Brand
              <select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)}>
                {brands.map((brand) => (
                  <option key={brand} value={brand}>{brand === 'all' ? 'All' : brand}</option>
                ))}
              </select>
            </label>
            <label>
              Availability
              <select value={availabilityFilter} onChange={(event) => setAvailabilityFilter(event.target.value)}>
                {AVAILABILITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {loading ? (
          <LoadingState message="Loading inventory..." />
        ) : error ? (
          <EmptyState title="Inventory unavailable" description={error} />
        ) : (
          <>
            <p className="inventory-result-count">{filteredProducts.length} product{filteredProducts.length === 1 ? '' : 's'} shown</p>
            <div className="inventory-table-wrap">
              <table className="inventory-table">
                <thead>
                  <tr>
                    <th>Image</th>
                    <th>Product Name</th>
                    <th>Brand</th>
                    <th>Category</th>
                    <th>Size</th>
                    <th>Color</th>
                    <th>Price</th>
                    <th>Quantity</th>
                    <th>Available</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product) => {
                    const status = getStatus(product);
                    const title = getProductTitle(product);

                    return (
                      <tr key={product.id}>
                        <td>
                          <img
                            className="inventory-thumb"
                            src={product.imageUrl || placeholderImage}
                            alt={title}
                            onError={(event) => {
                              event.currentTarget.onerror = null;
                              event.currentTarget.src = placeholderImage;
                            }}
                          />
                        </td>
                        <td className="inventory-product-name">{title}</td>
                        <td>{product.brand || '-'}</td>
                        <td>{product.category || '-'}</td>
                        <td>{product.size || '-'}</td>
                        <td>{product.color || '-'}</td>
                        <td>{formatCurrency(product.price)}</td>
                        <td>{getInventoryStock(product)}</td>
                        <td>{getSellableStock(product)}</td>
                        <td>{product.location || 'Unassigned'}</td>
                        <td>
                          <span className={`status-badge ${status.className}`}>{status.label}</span>
                        </td>
                        <td>
                          <div className="inventory-actions">
                            <button type="button" onClick={() => handleView(product)}>View</button>
                            <button type="button" onClick={() => handleEdit(product)}>Edit</button>
                            <button type="button" className="danger-action" onClick={() => handleDelete(product)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default AdminInventory;
