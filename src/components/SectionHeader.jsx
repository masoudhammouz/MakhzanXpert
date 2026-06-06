export default function SectionHeader({ eyebrow, title, description, className = '' }) {
  return (
    <div className={`section-header ${className}`.trim()}>
      {eyebrow && <span className="section-eyebrow">{eyebrow}</span>}
      <h2>{title}</h2>
      {description && <p className="section-description">{description}</p>}
    </div>
  );
}
