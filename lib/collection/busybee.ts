/**
 * BusyBee SMS — the one seam the "Additional Collection" feature sends through.
 *
 * Imported only by the collection server action, so it never reaches the client
 * bundle (no `server-only` guard needed — that package isn't a dependency here).
 *
 * Wired against BusyBee's SMSC HTTP API (`POST /api/v2/SendSMS`). Auth is a pair
 * of server-only credentials — an ApiKey AND a ClientId — plus an approved
 * SenderId and the gateway's base URL. All four are required; `smsConfigured()`
 * is false unless every one is set, so the feature never claims it can notify
 * when it can't. Do not scatter fetch calls elsewhere; keep the provider behind
 * this file.
 *
 * The credentials being server-only is the whole reason marking a store
 * "additional" goes through a server action instead of the client-side insert
 * every other store uses.
 */

/** Reads the four BusyBee settings from the environment. */
function config() {
  return {
    baseUrl: process.env.BUSYBEE_BASE_URL,
    apiKey: process.env.BUSYBEE_API_KEY,
    clientId: process.env.BUSYBEE_CLIENT_ID,
    senderId: process.env.BUSYBEE_SENDER_ID,
  }
}

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
  const { baseUrl, apiKey, clientId, senderId } = config()
  return !!(baseUrl && apiKey && clientId && senderId)
}

/**
 * Best-effort E.164 for PH mobiles: `09XXXXXXXXX` → `+639XXXXXXXXX`, and pass an
 * already-`+`-prefixed number through. Returns null for anything that doesn't
 * look dialable, so the caller can record a clean "no usable number" rather than
 * handing the provider garbage. `profiles.contact_number` (migration 104) is
 * nullable and only required for collector/delivery, so a null or odd value here
 * is expected, not exceptional. Also used by the Users action to validate input.
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
 * The number shape BusyBee's gateway expects: country-code digits with no `+`
 * (e.g. `639XXXXXXXXX`). Callers hand us E.164 from `toE164`, so we just drop the
 * leading plus.
 */
function toGatewayNumber(e164: string): string {
  return e164.replace(/^\+/, '')
}

/**
 * The provider's response to a send. There are TWO error layers, confirmed
 * against a live send:
 *
 *  - `ErrorCode` at the top is whether the request was *accepted* (auth, sender
 *    id, credits). Non-zero here means nothing was queued.
 *  - each `Data[]` entry then carries its own `MessageErrorCode` /
 *    `MessageErrorDescription` for that specific number — so the request can be
 *    accepted (top-level `ErrorCode: 0`) while an individual number still fails
 *    (e.g. blacklisted / invalid). A message id only exists when both are 0.
 */
interface SendSmsResponse {
  ErrorCode: number
  ErrorDescription?: string
  Data?: Array<{
    MobileNumber?: string
    MessageId?: string
    MessageErrorCode?: number
    MessageErrorDescription?: string
  }>
}

/**
 * Send one SMS through BusyBee's `POST /api/v2/SendSMS`. A send counts as
 * delivered-to-gateway only when the HTTP call succeeds, the top-level
 * `ErrorCode === 0` (request accepted) AND the per-number `MessageErrorCode` is
 * 0 (this number accepted); the provider message id then comes back in
 * `Data[0].MessageId`. A failure at any layer — bad credentials, no credits, an
 * invalid/blacklisted number, or a network error — maps to `ok: false` with a
 * reason, so the caller can tally and report it without ever throwing
 * mid-fan-out.
 */
export async function sendSms(req: SmsRequest): Promise<SmsResult> {
  const { baseUrl, apiKey, clientId, senderId } = config()
  if (!baseUrl || !apiKey || !clientId || !senderId) {
    // Not an error the admin must fix mid-task — the store is still listed and
    // mobile still badges it. Surface it as "not sent" so the UI can say so.
    console.warn('[busybee] not configured — SMS not sent to', req.to)
    return { to: req.to, ok: false, error: 'SMS not configured' }
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v2/SendSMS`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ApiKey: apiKey,
        ClientId: clientId,
        SenderId: senderId,
        Message: req.body,
        MobileNumbers: toGatewayNumber(req.to),
      }),
    })

    if (!res.ok) {
      return { to: req.to, ok: false, error: `HTTP ${res.status}` }
    }

    const data = (await res.json()) as SendSmsResponse
    if (data.ErrorCode !== 0) {
      return {
        to: req.to,
        ok: false,
        error: data.ErrorDescription
          ? `${data.ErrorDescription} (code ${data.ErrorCode})`
          : `Gateway error ${data.ErrorCode}`,
      }
    }

    // Request accepted; now check this specific number. We send one number per
    // call, so Data[0] is it — a missing entry means the gateway accepted the
    // request but told us nothing about the number, which we treat as a failure
    // rather than a false success.
    const entry = data.Data?.[0]
    if (!entry) {
      return { to: req.to, ok: false, error: 'Gateway returned no result for the number' }
    }
    if (entry.MessageErrorCode && entry.MessageErrorCode !== 0) {
      return {
        to: req.to,
        ok: false,
        error: entry.MessageErrorDescription
          ? `${entry.MessageErrorDescription} (code ${entry.MessageErrorCode})`
          : `Number rejected (code ${entry.MessageErrorCode})`,
      }
    }

    return { to: req.to, ok: true, id: entry.MessageId }
  } catch (err) {
    return {
      to: req.to,
      ok: false,
      error: err instanceof Error ? err.message : 'SMS request failed',
    }
  }
}

/** Send to many numbers, tolerating individual failures. Order is preserved. */
export async function sendSmsBatch(reqs: SmsRequest[]): Promise<SmsResult[]> {
  return Promise.all(reqs.map(sendSms))
}
