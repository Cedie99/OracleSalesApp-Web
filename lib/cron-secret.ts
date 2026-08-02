/**
 * These cron routes mutate client data in bulk (soft-delete, auto-lost,
 * customer-type promotion) and have no other gate in front of them, so every
 * handler must check this before touching the database.
 *
 * Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET` on
 * every invocation once `CRON_SECRET` is set in the project's env vars —
 * this just verifies that header matches. Set `CRON_SECRET` in `.env.local`
 * for local testing and in the Vercel project settings for production.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get('authorization') === `Bearer ${secret}`
}
