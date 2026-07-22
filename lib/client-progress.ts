import { mockMeetings } from '@/lib/mock/data'

// Binary per client rule: 100% once any saved meeting's agenda includes a
// product/company presentation, 0% otherwise — info completion has no weight.
export function getClientProgress(clientId: string): number {
  const presented = mockMeetings.some(m =>
    m.client_id === clientId && m.agenda.some(a => /product\s*\/?\s*company presentation/i.test(a))
  )
  return presented ? 100 : 0
}
