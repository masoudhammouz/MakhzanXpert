import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="footer footer-wide">
      <div className="footer-grid">
        <div>
          <p className="brand footer-brand">MakhzanXpert</p>
          <p className="footer-copy">Smart shoe inventory and ordering software for agile businesses.</p>
        </div>

        <div>
          <p className="footer-heading">Product</p>
          <Link to="/products" className="footer-link">Browse products</Link>
          <Link to="/admin/login" className="footer-link">Admin login</Link>
        </div>

        <div>
          <p className="footer-heading">Company</p>
          <a href="#" className="footer-link">About</a>
          <a href="#" className="footer-link">Contact</a>
        </div>
      </div>
      <div className="footer-bottom">
        <p>© 2026 MakhzanXpert. Built for modern inventory teams.</p>
      </div>
    </footer>
  );
}
