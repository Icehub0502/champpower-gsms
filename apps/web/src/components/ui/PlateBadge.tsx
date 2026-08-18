interface PlateBadgeProps {
  plate: string | undefined;
  province?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function PlateBadge({ plate, province, size = 'md' }: PlateBadgeProps) {
  return (
    <span className={`plate-tag plate-${size}`}>
      <span className="pt-no">{(plate || '-').trim()}</span>
      {province?.trim() && <span className="pt-prov">{province.trim()}</span>}
    </span>
  );
}
