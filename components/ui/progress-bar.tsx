export function ProgressBar({ value, barClass = 'w-16 h-1.5' }: { value: number; barClass?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`${barClass} rounded-full bg-muted overflow-hidden`}>
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] font-medium text-muted-foreground tabular-nums">{value}%</span>
    </div>
  )
}
