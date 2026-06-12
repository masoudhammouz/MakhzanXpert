import { Routes, Route, Navigate } from 'react-router-dom';
import CustomerLayout from './layouts/CustomerLayout.jsx';
import AdminLayout from './layouts/AdminLayout.jsx';
import Home from './pages/customer/Home.jsx';
import Products from './pages/customer/Products.jsx';
import ProductDetails from './pages/customer/ProductDetails.jsx';
import Cart from './pages/customer/Cart.jsx';
import Checkout from './pages/customer/Checkout.jsx';
import OrderSuccess from './pages/customer/OrderSuccess.jsx';
import AdminLogin from './pages/admin/AdminLogin.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import AdminInventory from './pages/admin/AdminInventory.jsx';
import AdminPlaceholder from './pages/admin/AdminPlaceholder.jsx';
import AdminAddProduct from './pages/admin/AdminAddProduct.jsx';
import AdminEditProduct from './pages/admin/AdminEditProduct.jsx';
import AdminOrders from './pages/admin/AdminOrders.jsx';
import AdminLocations from './pages/admin/AdminLocations.jsx';
import AdminCommands from './pages/admin/AdminCommands.jsx';
import AdminSensors from './pages/admin/AdminSensors.jsx';
import AdminLiveActivity from './pages/admin/AdminLiveActivity.jsx';
import AdminControlPanel from './pages/admin/AdminControlPanel.jsx';
import RequireAuth from './components/RequireAuth.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<CustomerLayout />}>
        <Route index element={<Home />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:slug" element={<ProductDetails />} />
        <Route path="product/:slug" element={<ProductDetails />} />
        <Route path="cart" element={<Cart />} />
        <Route path="checkout" element={<Checkout />} />
        <Route path="order-success" element={<OrderSuccess />} />
      </Route>

      <Route path="/admin" element={<AdminLayout />}>
        <Route path="login" element={<AdminLogin />} />
        <Route
          index
          element={
            <RequireAuth>
              <AdminDashboard />
            </RequireAuth>
          }
        />
        <Route
          path="inventory"
          element={
            <RequireAuth>
              <AdminInventory />
            </RequireAuth>
          }
        />
        <Route
          path="inventory/add"
          element={
            <RequireAuth>
              <AdminAddProduct />
            </RequireAuth>
          }
        />
        <Route
          path="inventory/edit/:id"
          element={
            <RequireAuth>
              <AdminEditProduct />
            </RequireAuth>
          }
        />
        <Route
          path="orders"
          element={
            <RequireAuth>
              <AdminOrders />
            </RequireAuth>
          }
        />
        <Route
          path="locations"
          element={
            <RequireAuth>
              <AdminLocations />
            </RequireAuth>
          }
        />
        <Route
          path="commands"
          element={
            <RequireAuth>
              <AdminCommands />
            </RequireAuth>
          }
        />
        <Route
          path="sensors"
          element={
            <RequireAuth>
              <AdminSensors />
            </RequireAuth>
          }
        />
        <Route
          path="live"
          element={
            <RequireAuth>
              <AdminLiveActivity />
            </RequireAuth>
          }
        />
        <Route
          path="control-panel"
          element={
            <RequireAuth>
              <AdminControlPanel />
            </RequireAuth>
          }
        />
        {[
          ['logs', 'Logs'],
        ].map(([path, title]) => (
          <Route
            key={path}
            path={path}
            element={
              <RequireAuth>
                <AdminPlaceholder title={title} />
              </RequireAuth>
            }
          />
        ))}
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
