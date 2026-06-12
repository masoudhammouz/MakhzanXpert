export default function EmptyState({ title, description }) {
  return (
    <section className="empty-state card">
      <h2>{title}</h2>
      <p className="section-description">{description}</p>
    </section>
  );
}
