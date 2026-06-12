export default function Button({ children, variant = 'primary', className = '', ...props }) {
  return (
    <button
      className={`button button-${variant} ${className}`.trim()}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}
