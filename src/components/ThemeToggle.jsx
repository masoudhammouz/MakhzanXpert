import { useTheme } from '../context/ThemeContext.jsx';

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button className="icon-button theme-toggle" type="button" onClick={toggleTheme} aria-label="Toggle theme">
      {theme === 'dark' ? '☀️' : '🌙'}
      <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  );
}
