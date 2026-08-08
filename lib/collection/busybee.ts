/**
 * BusyBee SMS — the one seam the "Additional Collection" feature sends through.
 *
 * Imported only by the collection server action, so it never reaches the client
 * bundle (no `server-only` guard needed — that package isn't a dependency here).
 *
 * ⚠️ STUB. The real BusyBee endpoint, auth, and response shape are not wired yet
 * (blocked on the provider's API details + final SMS copy). Everything around it
 * — the server action, the recipient resolution, the admin's success/failure
 * feedback — is built against THIS interface, so when the details arrive only the
 * body of `sendSms` changes. Do not scatter fetch calls elsewhere; keep the
 * provider behind this file.
 *
 * The key is server-only (`BUSYBEE_API_KEY`), which is the whole reason marking a
 * store "additional" goes through a server action instead of the client-side
 * insert every other store uses.
 */

/** A phone number is not sent until we have a plausible one — see toE164. */
export interface SmsRequest {
  /** Destination number. Resolved from `profiles.contact_number`. */
  to: string
  /** The message body. Kept <=160 chars by the caller so it stays one segment. */
  body: string
}

export interface SmsResult {
  to: string
  ok: boolean
  /** Provider message id on success — persisted later once we have a column. */
  id?: string
  /** Why it failed, for the admin's feedback and the server log. */
  error?: string
}

/** Whether the SMS path is actually wired. False keeps the feature honest. */
export function smsConfigured(): boolean {
  return !!process.env.BUSYBEE_API_KEY
}

/**
 * Best-effort E.164 for PH mobiles: `09XXXXXXXXX` → `+639XXXXXXXXX`, and pass an
 * already-`+`-prefixed number through. Returns null for anything that doesn't
 * look dialable, so the caller can record a clean "no usable number" rather than
 * handing the provider garbage. contact_number is NOT NULL (migration 001) but
 * nothing guarantees its shape, since mobile writes it.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.replace(/[\s()-]/g, '')
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed
  if (/^09\d{9}$/.test(trimmed)) return `+63${trimmed.slice(1)}`
  if (/^639\d{9}$/.test(trimmed)) return `+${trimmed}`
  return null
}

/**
 * Send one SMS. STUBBED: logs and reports a synthetic success so the rest of the
 * flow can be exercised end-to-end without a live provider. When BusyBee is
 * wired, replace the body below with the real call and map its response onto
 * `SmsResult` — nothing that calls this needs to change.
 */
export async function sendSms(req: SmsRequest): Promise<SmsResult> {
  if (!smsConfigured()) {
    // Not an error the admin must fix mid-task — the store is still listed and
    // mobile still badges it. Surface it as "not sent" so the UI can say so.
    console.warn('[busybee] BUSYBEE_API_KEY unset — SMS not sent to', req.to)
    return { to: req.to, ok: false, error: 'SMS not configured' }
  }

  // TODO(busybee): replace with the real request once the provider's endpoint,
  // auth header, and response body are known. Expected to be a POST with the
  // key in a header and { to, message } in the body; map the returned id/error
  // onto SmsResult. Until then, treat a configured key as a no-op success so
  // staging can flow through without spamming anyone.
  console.info('[busybee] (stub) would send SMS to', req.to, '—', req.body)
  return { to: req.to, ok: true, id: 'stub' }
}

/** Send to many numbers, tolerating individual failures. Order is preserved. */
export async function sendSmsBatch(reqs: SmsRequest[]): Promise<SmsResult[]> {
  return Promise.all(reqs.map(sendSms))
}
