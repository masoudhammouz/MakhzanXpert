import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { buildNormalizedSku, buildProductSlug } from '../utils/productVisibility.js';

const PRODUCT_CATEGORIES = ['Sneakers', 'Running', 'Casual', 'Boots', 'Sandals'];

const EMPTY_PRODUCT = {
  brand: '',
  model: '',
  category: 'Sneakers',
  size: '',
  color: '',
  price: '',
  quantity: '',
  location: '',
  imageUrl: '',
  description: '',
  isAvailable: true,
  status: 'active',
  needsDetails: false,
};

function normalizeInitialProduct(product) {
  return {
    ...EMPTY_PRODUCT,
    ...product,
    price: product?.price ?? '',
    quantity: product?.quantity ?? '',
    isAvailable: product?.isAvailable ?? Number(product?.quantity || 0) > 0,
    status: product?.status ?? (product?.needsDetails ? 'pending_details' : 'active'),
    needsDetails: Boolean(product?.needsDetails),
  };
}

function validateProduct(values) {
  const errors = {};
  const requiredFields = ['brand', 'model', 'size', 'color', 'quantity'];

  if (values.isAvailable) {
    requiredFields.push('category', 'price', 'imageUrl', 'description');
  }

  requiredFields.forEach((field) => {
    if (values[field] === '' || values[field] === null || values[field] === undefined) {
      errors[field] = 'Required';
    }
  });

  const price = Number(values.price);
  const quantity = Number(values.quantity);

  if (values.price !== '' && values.price !== null && Number.isNaN(price)) {
    errors.price = 'Price must be a number';
  }

  if (values.quantity !== '' && Number.isNaN(quantity)) {
    errors.quantity = 'Quantity must be a number';
  } else if (quantity < 0) {
    errors.quantity = 'Quantity cannot be negative';
  }

  return errors;
}

function ProductForm({ initialProduct, mode = 'add', onSubmit, saving = false, error = '' }) {
  const [values, setValues] = useState(() => normalizeInitialProduct(initialProduct));
  const [errors, setErrors] = useState({});

  const title = mode === 'edit' ? 'Edit Product' : 'Add Product';
  const submitLabel = saving ? 'Saving...' : mode === 'edit' ? 'Save Changes' : 'Add Product';
  const hasPreview = useMemo(() => values.imageUrl.trim().length > 0, [values.imageUrl]);

  const handleChange = (event) => {
    const { name, type, value, checked } = event.target;
    setValues((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validateProduct(values);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    await onSubmit({
      brand: values.brand.trim(),
      model: values.model.trim(),
      category: values.category.trim(),
      size: values.size.trim(),
      color: values.color.trim(),
      price: values.price === '' || values.price === null ? null : Number(values.price),
      quantity: Number(values.quantity),
      location: values.location.trim(),
      imageUrl: values.imageUrl.trim(),
      description: values.description.trim(),
      isAvailable: Boolean(values.isAvailable) && Number(values.quantity) > 0,
      normalizedSku: buildNormalizedSku(values),
      slug: buildProductSlug(values),
      status: values.isAvailable ? 'active' : 'pending_details',
      needsDetails: !values.isAvailable,
      createdFromLabel: Boolean(values.createdFromLabel),
    });
  };

  return (
    <section className="admin-product-form-page">
      <div className="admin-page-heading">
        <div>
          <p className="section-eyebrow">Inventory editor</p>
          <h1>{title}</h1>
          <p>Maintain the product fields used by the customer catalog and future warehouse automation.</p>
        </div>
      </div>

      <form className="admin-product-form" onSubmit={handleSubmit}>
        {error && <p className="admin-form-error">{error}</p>}

        <div className="admin-form-grid">
          <label>
            Brand
            <input name="brand" value={values.brand} onChange={handleChange} />
            {errors.brand && <span>{errors.brand}</span>}
          </label>

          <label>
            Model
            <input name="model" value={values.model} onChange={handleChange} />
            {errors.model && <span>{errors.model}</span>}
          </label>

          <label>
            Category
            <select name="category" value={values.category} onChange={handleChange}>
              <option value="">Select category</option>
              {PRODUCT_CATEGORIES.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
            {errors.category && <span>{errors.category}</span>}
          </label>

          <label>
            Size
            <input name="size" value={values.size} onChange={handleChange} />
            {errors.size && <span>{errors.size}</span>}
          </label>

          <label>
            Color
            <input name="color" value={values.color} onChange={handleChange} />
            {errors.color && <span>{errors.color}</span>}
          </label>

          <label>
            Price
            <input name="price" value={values.price} onChange={handleChange} inputMode="decimal" />
            {errors.price && <span>{errors.price}</span>}
          </label>

          <label>
            Quantity
            <input name="quantity" value={values.quantity} onChange={handleChange} inputMode="numeric" />
            {errors.quantity && <span>{errors.quantity}</span>}
          </label>

          <label>
            Location
            <input name="location" value={values.location} onChange={handleChange} placeholder="Aisle / shelf / bin" />
          </label>

          <label className="admin-form-wide">
            Image URL
            <input name="imageUrl" value={values.imageUrl} onChange={handleChange} />
          </label>

          <label className="admin-form-wide">
            Description
            <textarea name="description" value={values.description} onChange={handleChange} rows="5" />
          </label>

          <label className="admin-availability-toggle">
            <input name="isAvailable" type="checkbox" checked={values.isAvailable} onChange={handleChange} />
            Available for customers
          </label>

          {values.needsDetails && (
            <div className="admin-form-wide pending-details-note">
              <strong>Needs details</strong>
              <span>Complete price, category, images, and description before making it available for customers.</span>
            </div>
          )}
        </div>

        {hasPreview && (
          <div className="admin-form-preview">
            <p className="spec-label">Image preview</p>
            <img src={values.imageUrl} alt="Product preview" />
          </div>
        )}

        <div className="admin-form-actions">
          <Link to="/admin/inventory" className="button button-secondary">Cancel</Link>
          <button className="button button-primary" type="submit" disabled={saving}>
            {submitLabel}
          </button>
        </div>
      </form>
    </section>
  );
}

export default ProductForm;
