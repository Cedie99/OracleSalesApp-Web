'use client'

import { Input } from '@/components/ui/input'
import { toCentavo } from '@/lib/money'

/**
 * A peso amount as typed, centavos included ("1500.50"). A string so the field
 * can legitimately be empty, or end in "." while the admin is still typing.
 */
export type PesoValue = string

export const EMPTY_PESO: PesoValue = ''

/** The typed amount as a number, or NaN when nothing has been typed. */
export function pesoValueAmount(v: PesoValue): number {
  if (!v || v === '.') return NaN
  return toCentavo(Number(v))
}

/**
 * Keeps only what a peso amount can be: digits, one decimal point, and at most
 * two centavo digits after it.
 */
function cleanPeso(raw: string): PesoValue {
  const digits = raw.replace(/[^\d.]/g, '')
  const dot = digits.indexOf('.')
  if (dot === -1) return digits
  const whole = digits.slice(0, dot)
  const cents = digits.slice(dot + 1).replace(/\./g, '').slice(0, 2)
  return `${whole}.${cents}`
}

/** One peso amount field that accepts centavos, e.g. 1500.50. */
export function PesoInput({
  id,
  value,
  onChange,
  className,
  size = 'default',
}: {
  id?: string
  value: PesoValue
  onChange: (value: PesoValue) => void
  className?: string
  size?: 'default' | 'sm'
}) {
  return (
    <div className={`relative ${className ?? ''}`}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        ₱
      </span>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={e => onChange(cleanPeso(e.target.value))}
        placeholder="0.00"
        className={`pl-6 tabular-nums ${size === 'sm' ? 'h-7 text-xs md:text-xs' : ''}`}
      />
    </div>
  )
}
