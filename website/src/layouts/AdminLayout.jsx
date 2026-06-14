import { Link, NavLink, Outlet } from 'react-router-dom';
import LanguageToggle from '../components/LanguageToggle.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

const adminLinks = [
  { label: 'Dashboard', to: '/admin', end: true },
  { label: 'Inventory', to: '/admin/inventory' },
  { label: 'Orders', to: '/admin/orders' },
  { label: 'Locations', to: '/admin/locations' },
  { label: 'Commands', to: '/admin/commands' },
  { label: 'Sensors', to: '/admin/sensors' },
  { label: 'Live Activity', to: '/admin/live' },
  { label: 'Control Panel', to: '/admin/control-panel' },
  { label: 'Logs', to: '/admin/logs' },
];

function AdminLayout() {
  return (
    <div className="app-shell admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <span className="auth-branding-mark">MX</span>
          <div>
            <p className="admin-sidebar-title">MakhzanXpert</p>
            <p className="admin-sidebar-subtitle">Admin</p>
          </div>
        </div>

        <Link to="/" className="admin-store-link" aria-label="Go to customer store">
          <span aria-hidden="true">Store</span>
          Customer Store
        </Link>

        <nav className="admin-sidebar-nav" aria-label="Admin navigation">
          {adminLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => (isActive ? 'admin-sidebar-link active' : 'admin-sidebar-link')}
            >
              {link.label}
              {!['Dashboard', 'Inventory', 'Orders', 'Locations', 'Commands', 'Sensors', 'Live Activity', 'Control Panel'].includes(link.label) && <span>Placeholder</span>}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="admin-main-shell">
        <header className="topbar admin-topbar">
          <div>
            <p className="admin-topbar-kicker">Operations console</p>
            <h1>MakhzanXpert Admin</h1>
          </div>

          <div className="admin-actions">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>

        <main className="content page-container admin-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AdminLayout;
