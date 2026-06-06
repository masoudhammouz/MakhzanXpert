import { useEffect, useState } from 'react';

export default function SearchBar({ value = '', onChange, onSubmit, placeholder = 'Search products', className = '' }) {
  const [internalValue, setInternalValue] = useState(value);

  useEffect(() => {
    setInternalValue(value);
  }, [value]);

  const handleChange = (event) => {
    const nextValue = event.target.value;
    setInternalValue(nextValue);
    onChange?.(nextValue);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit?.(internalValue.trim());
  };

  return (
    <form className={`search-bar ${className}`.trim()} onSubmit={handleSubmit}>
      <label className="search-field">
        <span className="search-icon">🔍</span>
        <input
          type="search"
          value={internalValue}
          onChange={handleChange}
          placeholder={placeholder}
          aria-label="Search"
        />
      </label>
      <button className="search-action" type="submit">
        Search
      </button>
    </form>
  );
}
