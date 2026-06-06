import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

function AdminLogin() {
  const { currentUser, login, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && currentUser) {
      navigate('/admin', { replace: true });
    }
  }, [currentUser, loading, navigate]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await login(email, password);
      navigate('/admin', { replace: true });
    } catch (authError) {
      setError('Login failed. Check email and password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-login-page">
      <section className="auth-panel card admin-login-card">
        <div className="auth-branding">
          <div className="auth-branding-mark">MX</div>
          <div>
            <p className="eyebrow">MakhzanXpert Admin</p>
            <p className="auth-subtitle">Secure admin access for warehouse operations and inventory control.</p>
          </div>
        </div>

        <div className="auth-header">
          <h1>Welcome back, administrator</h1>
          <p className="section-copy">Sign in to manage products, view performance, and monitor your operation in one place.</p>
        </div>

        <form className="auth-form admin-login-form" onSubmit={handleSubmit}>
          <label className="form-label">
            Email address
            <input
              className="input-field admin-input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@example.com"
              required
            />
          </label>

          <label className="form-label">
            Password
            <input
              className="input-field admin-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
            />
          </label>

          {error && <div className="error-message admin-error-message">{error}</div>}

          <button className="button-primary admin-submit-button" type="submit" disabled={submitting || loading}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="note auth-note">Need help? Contact your system administrator.</p>
      </section>
    </div>
  );
}

export default AdminLogin;
