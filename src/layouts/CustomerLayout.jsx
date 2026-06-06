import { Outlet } from 'react-router-dom';
import Navbar from '../components/Navbar.jsx';
import Footer from '../components/Footer.jsx';
import { CartProvider } from '../context/CartContext.jsx';

function CustomerLayout() {
  return (
    <CartProvider>
      <div className="app-shell">
        <Navbar />

        <main className="page-content">
          <Outlet />
        </main>

        <Footer />
      </div>
    </CartProvider>
  );
}

export default CustomerLayout;
