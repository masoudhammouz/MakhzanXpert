import { Link, NavLink } from 'react-router-dom';
import { useCart } from '../context/CartContext.jsx';
import logoImage from '../assets/makhzanxpert-logo.png';
import LanguageToggle from './LanguageToggle.jsx';
import ThemeToggle from './ThemeToggle.jsx';

export default function MobileMenu({ open, onClose }) {
  const { totalItems } = useCart();

  if (!open) {
    return null;
  }

  return (
    <div className="mobile-menu-overlay premium-mobile-overlay" onClick={onClose}>
      <aside className="mobile-menu premium-mobile-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="mobile-menu-header premium-mobile-header">
          <Link to="/" className="premium-logo-link" onClick={onClose} aria-label="MakhzanXpert home">
            <img src={logoImage} alt="MakhzanXpert" className="premium-logo" />
          </Link>
          <button className="premium-icon-button close-menu" type="button" onClick={onClose} aria-label="Close menu">
            x
          </button>
        </div>

        <nav className="mobile-nav-list premium-mobile-nav" aria-label="Mobile navigation">
          <NavLink to="/" className="mobile-nav-link" onClick={onClose}>
            Home
          </NavLink>
          <NavLink to="/products" className="mobile-nav-link" onClick={onClose}>
            Products
          </NavLink>
          <Link to="/cart" className="mobile-nav-link" onClick={onClose}>
            Cart <span>{totalItems}</span>
          </Link>
          <NavLink to="/admin/login" className="mobile-nav-link subtle-mobile-link" onClick={onClose}>
            Admin
          </NavLink>
        </nav>

        <div className="mobile-menu-actions premium-mobile-actions">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </aside>
    </div>
  );
}
