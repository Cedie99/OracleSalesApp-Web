"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { CheckIcon, MinusIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A tick box.
 *
 * Base UI, not Radix — this repo has no @radix-ui dependency; see
 * components/ui/separator.tsx for the same wrapping shape. `Checkbox.Root`
 * renders a `<span>` (role="checkbox") plus a hidden `<input>`, which is why
 * the disabled styling hangs off `data-disabled` rather than the `disabled:`
 * variant: there is no form control here for `:disabled` to match.
 *
 * Square rather than the pill shape the rest of the design system uses — a
 * rounded-full tick box reads as a radio button, and these are multi-select.
 * BizLink's catalogue has no checkbox entry to follow (§3 covers buttons,
 * badges and inputs only), so this borrows the input's border treatment.
 *
 * `indeterminate` drives the mixed state a "select all" control needs — some
 * but not all of the group ticked — and swaps the check for a dash. The
 * Indicator mounts on `checked || indeterminate` and unmounts otherwise
 * (CheckboxIndicator.js), so neither icon needs a hide-when-unchecked rule.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "group/checkbox peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background p-0 transition-colors outline-none",
        "hover:border-primary/60",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
        "data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground",
        "data-disabled:cursor-not-allowed data-disabled:opacity-40 data-disabled:hover:border-border",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <CheckIcon className="size-3 group-data-indeterminate/checkbox:hidden" strokeWidth={3} />
        <MinusIcon className="hidden size-3 group-data-indeterminate/checkbox:block" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
