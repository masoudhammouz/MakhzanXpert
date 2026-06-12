import { createContext, useContext, useEffect, useState } from 'react';

const CartContext = createContext(null);

const STORAGE_KEY = 'mx_cart_v1';

function initializeCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load cart from storage', e);
    return [];
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(initializeCart);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      console.error('Failed to save cart to storage', e);
    }
  }, [items]);

  const findIndex = (productId) => items.findIndex((it) => it.id === productId);

  function addToCart(product, quantity = 1) {
    setItems((prev) => {
      const idx = prev.findIndex((p) => p.id === product.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], quantity: copy[idx].quantity + quantity };
        return copy;
      }
      return [...prev, { ...product, quantity }];
    });
  }

  function removeFromCart(productId) {
    setItems((prev) => prev.filter((p) => p.id !== productId));
  }

  function increaseQuantity(productId) {
    setItems((prev) => prev.map((p) => (p.id === productId ? { ...p, quantity: p.quantity + 1 } : p)));
  }

  function decreaseQuantity(productId) {
    setItems((prev) => prev
      .map((p) => (p.id === productId ? { ...p, quantity: Math.max(1, p.quantity - 1) } : p)));
  }

  function clearCart() {
    setItems([]);
  }

  const totalItems = items.reduce((s, it) => s + (it.quantity || 0), 0);
  const subtotal = items.reduce((s, it) => s + (it.price || 0) * (it.quantity || 0), 0);

  return (
    <CartContext.Provider value={{ items, addToCart, removeFromCart, increaseQuantity, decreaseQuantity, clearCart, totalItems, subtotal }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider');
  return ctx;
}

export default CartContext;
