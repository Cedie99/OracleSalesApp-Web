import type { Meeting } from '@/types'

// Binary per client rule: 100% once any saved meeting's agenda includes a
// product/company presentation, 0% otherwise — info completion has no weight.
//
// Takes the meetings to search rather than importing them, so one rule serves
// both the mock-backed pages and the Supabase-backed Clients page.
//
// Matched as a regex, not string equality: agenda is a text[] written by the
// mobile app. The live value is "Product / company presentation" (15 of 30
// rows on 2026-07-24), but the spacing around the slash is the phone's to
// change and equality would fail silently the day it does.
export function getClientProgress(clientId: string, meetings: Meeting[]): number {
  const presented = meetings.some(
    m =>
      m.client_id === clientId &&
      (m.agenda ?? []).some(a => /product\s*\/?\s*company presentation/i.test(a))
  )
  return presented ? 100 : 0
}
