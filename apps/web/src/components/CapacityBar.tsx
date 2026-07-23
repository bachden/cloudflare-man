export function CapacityBar({ value, limit, compact = false }: { value: number; limit: number; compact?: boolean }) {
  const percent = Math.min(100, limit > 0 ? (value / limit) * 100 : 0);
  const tone = percent >= 90 ? "capacity-danger" : percent >= 75 ? "capacity-warning" : "";
  return (
    <div className={`capacity ${compact ? "capacity-compact" : ""}`}>
      <div className="capacity-label"><span>{value.toLocaleString()}</span><span>{limit.toLocaleString()}</span></div>
      <div className="capacity-track"><div className={`capacity-fill ${tone}`} style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

