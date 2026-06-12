import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext.jsx';
import logoImage from '../assets/makhzanxpert-logo.png';
import LanguageToggle from './LanguageToggle.jsx';
import MobileMenu from './MobileMenu.jsx';
import ThemeToggle from './ThemeToggle.jsx';

const navLinks = [
  { label: 'Home', to: '/' },
  { label: 'Products', to: '/products' },
];

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="nav-svg-icon">
      <path d="M10.8 5.2a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 0 1 0-11.2Zm0-2a7.6 7.6 0 1 0 4.7 13.6l3.1 3.1 1.4-1.4-3.1-3.1A7.6 7.6 0 0 0 10.8 3.2Z" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="nav-svg-icon">
      <path d="M7 6h14l-1.7 8.5a2 2 0 0 1-2 1.5H9.1a2 2 0 0 1-2-1.6L5.6 4H3V2h4.3L7 6Zm.3 2 1.1 6h8.9l1.2-6H7.3ZM9 22a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm8 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="nav-svg-icon">
      <path d="M4 7h16v2H4V7Zm0 4h16v2H4v-2Zm0 4h16v2H4v-2Z" />
    </svg>
  );
}

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { totalItems } = useCart();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setSearchTerm(params.get('q') || '');
  }, [location.search]);

  const submitSearch = (event) => {
    event.preventDefault();
    const query = searchTerm.trim();
    setSearchOpen(false);
    navigate(`/products${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  };

  return (
    <header className="navbar premium-navbar">
      <Link to="/" className="premium-logo-link" aria-label="MakhzanXpert home">
        <img src={logoImage} alt="MakhzanXpert" className="premium-logo" />
      </Link>

      <nav className="premium-nav-center" aria-label="Primary navigation">
        {navLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => (isActive ? 'premium-nav-link active' : 'premium-nav-link')}
          >
            {link.label}
          </NavLink>
        ))}
      </nav>

      <div className="premium-nav-actions">
        <button className="premium-icon-button desktop-nav-action" type="button" onClick={() => setSearchOpen(true)} aria-label="Search products">
          <SearchIcon />
        </button>
        <Link to="/cart" className="premium-icon-button premium-cart-button" aria-label="View cart">
          <CartIcon />
          <span className="premium-cart-badge">{totalItems}</span>
        </Link>
        <div className="desktop-nav-action">
          <LanguageToggle />
        </div>
        <div className="desktop-nav-action">
          <ThemeToggle />
        </div>
        <NavLink to="/admin/login" className="premium-admin-link desktop-nav-action">
          Admin
        </NavLink>
        <button className="premium-icon-button premium-menu-button" type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu">
          <MenuIcon />
        </button>
      </div>

      {searchOpen && (
        <div className="search-modal-backdrop" onClick={() => setSearchOpen(false)}>
          <form className="search-modal" onSubmit={submitSearch} onClick={(event) => event.stopPropagation()}>
            <label htmlFor="site-search">Search products</label>
            <div className="search-modal-row">
              <input
                id="site-search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by brand, model, color, category"
                autoFocus
              />
              <button className="button button-primary" type="submit">Search</button>
            </div>
          </form>
        </div>
      )}

      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </header>
  );
}
