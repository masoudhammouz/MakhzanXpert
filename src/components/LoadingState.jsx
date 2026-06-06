export default function LoadingState({ message = 'Loading…' }) {
  return (
    <section className="empty-state card loading-state">
      <h2>{message}</h2>
    </section>
  );
}
