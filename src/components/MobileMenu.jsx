import { Link, NavLink } from 'react-router-dom';
import { useCart } from '../context/CartContext.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import SearchBar from './SearchBar.jsx';
import ThemeToggle from './ThemeToggle.jsx';

export default function MobileMenu({ open, onClose, searchValue, onSearchChange, onSearchSubmit }) {
  const { totalItems } = useCart();

  if (!open) {
    return null;
  }

  return (
    <div className="mobile-menu-overlay" onClick={onClose}>
      <aside className="mobile-menu" onClick={(event) => event.stopPropagation()}>
        <div className="mobile-menu-header">
          <p className="mobile-menu-title">Menu</p>
          <button className="icon-button close-menu" type="button" onClick={onClose} aria-label="Close menu">
            x
          </button>
        </div>

        <SearchBar
          value={searchValue}
          onChange={onSearchChange}
          onSubmit={onSearchSubmit}
          placeholder="Search shoes"
        />

        <nav className="mobile-nav-list">
          <NavLink to="/" className="mobile-nav-link" onClick={onClose}>
            Home
          </NavLink>
          <NavLink to="/products" className="mobile-nav-link" onClick={onClose}>
            Products
          </NavLink>
          <Link to="/cart" className="mobile-nav-link" onClick={onClose}>
            Cart {totalItems > 0 ? `- ${totalItems}` : ''}
          </Link>
          <NavLink to="/admin/login" className="mobile-nav-link" onClick={onClose}>
            Admin
          </NavLink>
        </nav>

        <div className="mobile-menu-actions">
          <ThemeToggle />
          <LanguageToggle />
        </div>
      </aside>
    </div>
  );
}
