import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import MobileMenu from './MobileMenu.jsx';
import SearchBar from './SearchBar.jsx';
import ThemeToggle from './ThemeToggle.jsx';

const navLinks = [
  { label: 'Home', to: '/' },
  { label: 'Products', to: '/products' },
  { label: 'Admin', to: '/admin/login' },
];

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { totalItems } = useCart();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setSearchTerm(params.get('q') || '');
  }, [location.search]);

  const handleSearchChange = (value) => {
    setSearchTerm(value);
    if (location.pathname === '/products') {
      navigate({ pathname: '/products', search: value ? `?q=${encodeURIComponent(value)}` : '' });
    }
  };

  const handleSearchSubmit = (value) => {
    const query = value.trim();
    if (location.pathname !== '/products') {
      navigate(`/products${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    } else {
      navigate({ pathname: '/products', search: query ? `?q=${encodeURIComponent(query)}` : '' });
    }
  };

  return (
    <header className="navbar">
      <div className="navbar-brand">
        <Link to="/" className="brand-link">MakhzanXpert</Link>
      </div>

      <div className="navbar-center">
        <nav className="nav-list">
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="navbar-search desktop-only">
          <SearchBar
            value={searchTerm}
            onChange={handleSearchChange}
            onSubmit={handleSearchSubmit}
            placeholder="Search shoe inventory"
          />
        </div>
      </div>

      <div className="navbar-actions">
        <div className="navbar-controls desktop-only">
          <ThemeToggle />
          <LanguageToggle />
          <Link to="/cart" className="icon-button cart-link" aria-label="View cart">
            Cart
            <span className="cart-count-badge">{totalItems}</span>
          </Link>
        </div>
        <button className="icon-button mobile-menu-button" type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu">
          Menu
        </button>
      </div>

      <MobileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        searchValue={searchTerm}
        onSearchChange={handleSearchChange}
        onSearchSubmit={handleSearchSubmit}
      />
    </header>
  );
}
