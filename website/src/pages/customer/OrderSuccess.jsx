import { Link } from 'react-router-dom';

function OrderSuccess() {
  return (
    <div className="order-success-page">
      <section className="order-success-card card">
        <p className="section-eyebrow">Order confirmed</p>
        <h1>Order placed successfully</h1>
        <p>Your order has been received and is now pending preparation.</p>
        <Link to="/products" className="button button-primary">
          Back to Products
        </Link>
      </section>
    </div>
  );
}

export default OrderSuccess;
