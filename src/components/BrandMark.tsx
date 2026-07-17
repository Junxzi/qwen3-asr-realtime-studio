export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand-wave brand-wave--compact" : "brand-wave"} aria-hidden="true">
      {[8, 16, 22, 12, 20, 10].map((height, index) => <i key={`${height}-${index}`} style={{ height }} />)}
    </span>
  );
}
