# Collection & Delivery — what web built, and what mobile needs to change

> Written by Dev2 (Adrian, web repo) on 2026-07-27 for Dev3/Dev4 (Carter/Ced, mobile repo), or for whoever picks up the mobile side.
>
> Companion docs: `SUPABASE_CHANGES_FOR_MOBILE.md` (schema deltas already deployed), `MOBILE_STATUS.md` (cross-repo state).

## Read this first

**Status, 2026-07-31 → see §12.** It answers mobile's `COLLECTION_DELIVERY_STATUS_MOBILE.md` point by point. Short version: the claim display it lists as the one thing blocking mobile has been shipped since `c9e0bf8`, remittance reconciliation is now built, and the Phase 2b/2c photos are rendering in the admin. Nothing on this doc is waiting on web.

**Status, 2026-07-28: 043/044 are merged to main and deployed.** Commit `9c40364`; CI's `db push` ran on merge. The paragraph below describes the pre-merge state and is kept for the numbering rationale, which still applies.

**045 is now taken** by `045_denormalize_client_on_lists.sql` — see §4a. The location-pings proposal in §7 that reserved the name `045_location_pings.sql` moves to **046** if it is ever approved.

`043_collection_module.sql` and `044_delivery_module.sql` were written and sat on a branch unmerged. Verified against the live project on 2026-07-27: `collection_visits`, `remittances`, `purchase_orders` and `cod_remittances` did **not** exist there yet, so nothing below conflicted with anything deployed.

**Why 043/044 and not 025/026.** These were first written as 025/026 — the next free numbers in web's own folder, which stops at 024. That was wrong. The vault's `Migration-0NN-Report.md` files show 025–042 are already claimed by the mobile side, and **every one of them is applied live**: 025–027 on 2026-07-23, 028–034 on 2026-07-26, and 035–040 plus 042 on 2026-07-27. Only 041 is free, and only because it was reserved as a numbering placeholder and never used. Web's folder jumping from 024 to 043 is correct, not a mistake — don't "tidy" it.

Related, from the vault's `Web-Migration-Backfill-Action-2026-07-26.md`:

- **The seventeen backfill files — 025–040 and 042 — are now committed**, on this branch. All were already live and none were re-run; they exist so the repo's history matches production and a rebuild from `supabase/migrations/` alone reproduces the live schema. That note names only 025/026/027 because it predates Batch 2 and Batch 3; the real figure was seventeen. Two things worth knowing about how they were captured: **034 is committed as corrected, not as first applied** (the original used the wrong identity column and dropped a guessed policy name, both fixed the same day), and because none of the seventeen were in the remote `schema_migrations`, each version is registered with `supabase migration repair --status applied` **before** this branch merges — otherwise CI's `db push` would try to execute SQL that is already live and fail. Only 041 is absent, and deliberately: reserved as a placeholder, never used.
- Web's `023_add_delivery_role.sql` is the documented precedent for why this matters: it rewrote `profiles_role_check` without knowing the mobile side had added a value to it, silently dropping that value and breaking a live account. Exactly the collision 043/044 just avoided — and exactly what committing 027 now prevents from recurring.

Also caught during the same check: `current_profile_id()` **already exists live** (added by the mobile side outside web's migration history). 043 therefore creates it only if absent rather than `CREATE OR REPLACE`, so it cannot silently redefine a function that live RLS policies we don't own already depend on.

**They create empty tables — no seed, no test rows, by design.** The lists get created for real through web's Collection and Delivery admin pages, and mobile then works those real lists. Fabricated rows would only teach us that fabricated rows render.

They stay unmerged until you've read §4. Merging to main runs `supabase db push` against the **shared** project immediately — so this is the last cheap moment to change the shape.

Both apps still run on mock data (`lib/mock/data.ts` on web, `lib/collection-delivery-data.ts` on mobile), and our two mock models have already drifted in ways that would be expensive to discover after both sides ship.

**§4 (drift) and §5 (offline) are the parts that need your eyes.** Everything else is context.

---

## 1. What web shipped on 2026-07-27

| Change | Mobile impact |
| --- | --- |
| **Delivery gained GPS** — reverses the "no GPS in delivery" rule | 🔴 **Yes — biggest item.** §2 |
| **Trip maps** for Collection and Delivery — a day's stops joined in worked order | 🔴 Yes — depends on fields mobile must write. §3 |
| **Per-module dashboards** — Collection leads on money not yet in the office; Delivery on goods that came back | 🟡 Indirect — needs the same fields |
| **Per-module reports** — Collection stores + remittances; Delivery trip report + COD remittances | 🟡 Indirect |
| **Admin roles categorised** via `profiles.admin_scope` (`all\|sales\|collection\|delivery`) | ⚪ **None.** §6 |

---

## 2. ⚠️ Delivery now has GPS — the "no GPS" rule is dead

Every previous source said delivery captures no location. The wireframe said it outright — *"Walang GPS sa delivery module (per confirmed scope) — timestamp + proof photo lang"* — and web's own `types/index.ts` carried a comment reading **"do not add GPS fields; their absence is the decision, not a gap."**

**Reversed as of 2026-07-27** (from the latest client meeting). The office wants to trace a driver's route across a day, the same way it traces a collector's.

It was cheap to reverse because **the fix rides along with the image capture that already happens at every stop** — no extra step for the driver, no new screen. `PurchaseOrder` now carries `gps_lat` / `gps_lng`, captured at photo time.

Build this consequence correctly: **no photo means no location.** A stop closed out without a capture has no fix, and web renders it as "No pin", excluded from the route line rather than guessed at. Never synthesise a coordinate to fill the gap.

**The vault and the wireframes have not been updated.** If you go back to them you'll read the old rule. Don't restore it.

---

## 3. Trip maps — and what "trail" means here

Web now draws, for one collector or driver on one day: their stops as numbered pins, in the order they worked them, joined by a line.

**Scope: Collection and Delivery only. Not sales, not meetings.** This is deliberate and won't change. A sales agent's day is a set of appointments, not a published run worked in sequence — joining one agent's meetings into a line would assert a route nobody drove. Collection and Delivery are the only modules where the day *is* a run, because the admin publishes one list per day and the field worker works it down. If anyone asks for meeting trails, that's a different feature with a different meaning.

**What orders a trip:**

- **Delivery** — `sequence_no`, which the driver's app assigns at each stop from the order actually visited. Falls back to `time_out`.
- **Collection** — `visited_at` only. There is no sequence number on the collection side, so **the timestamp is the entire ordering signal.** If it isn't a real timestamp, no collection trip can be drawn at all.

Trips are grouped **per worker per day**, never per worker alone — otherwise Monday's last stop chains to Tuesday's first and draws a line across a night the truck spent parked.

Today the line between stops is **straight and dashed**, meaning "we know where they stopped, never which roads they took." Making it follow real roads is §7.

---

## 4. Drift: mobile's current F-007 draft vs web's model

From `lib/collection-delivery-data.ts` on mobile `main`, against `types/index.ts` on web. Neither is deployed, so all of this is cheap to fix **now** and expensive later.

### Delivery — `DeliveryPo` vs `PurchaseOrder`

| Mobile draft | Web model | Why |
| --- | --- | --- |
| `status: 'pending' \| 'followup' \| 'delivered' \| 'backload'` | `'pending' \| 'delivered' \| 'failed'` | **One day, one outcome.** No follow-up window. And a failed delivery **is** a backload — nothing was accepted, so the goods ride back. One outcome, not two; `backload_photo_url` is a capture on a failed row, not a status. |
| `day?: number` (follow-up 1–3) | *(none)* | The 3-day rule was never a delivery rule. It's Meeting-2026-06-24's **client-lifecycle** auto-delete, superseded by the 1-month rule on July 3, which leaked into the delivery wireframes. Delete the field and any countdown built on it. |
| `items: string` | *(none)* | Admin lists **customer + area only**. The trip ticket is customer + plate; the goods are on the paper PO the driver carries. The paper Trip Report has no items column at all. |
| *(none)* | `gps_lat`, `gps_lng` | New — §2. |
| `time?: string` (`'8:32 AM'`) | `time_in`, `time_out` (timestamptz) | A display string can't be ordered, subtracted, or timezone-corrected. Web computes **dwell** from `time_out − time_in`. Both ends are needed **including on a failed stop** — the truck still arrived, waited, and left. |
| `seq?: number` | `sequence_no` | Same concept; mobile's comment on it is correct. Name only. |
| `receiver?: string` | `receiver_name` + `receiver_signature_url` | Name is optional (customers refuse); the **signature** is the real proof and appears on every row of the paper sheet. |
| `id: number` | `id: string` (UUID) | Sequential ints don't survive offline creation across devices — and mobile's own outbox is already built on client-generated IDs. |

### Collection — `CollectionStore` vs `CollectionVisit`

| Mobile draft | Web model | Why |
| --- | --- | --- |
| `PaymentMethod = 'Cash' \| 'Check' \| 'GCash'` | `'cash' \| 'check' \| 'gcash' \| 'counter'` | **`counter` is missing.** The 2026-07-26 change turned Counter from a third proof capture into a payment method whose proof rides on the shared payment photo. Also lowercase values; labels formatted at display time. |
| `status: 'resched'` | `'rescheduled'` | Naming only. |
| `time?: string` | `visited_at` (timestamptz) | **This is what orders a collection trip** (§3). Highest-value fix on this table. |
| *(none)* | `collector_id` | Who actually worked the store, written **when they collect**, never assigned in advance. Null while pending. Mobile's draft is right that the *list* carries no collector — but the value must land on the record at collection time or web can't group a trip. |
| *(none)* | `payment_photo_url`, `delivery_receipt_photo_url` | Two required captures on a collected visit. Web flags a collected row missing either as "missing proof" for the admin to chase. |
| *(none)* | `gps_lat`, `gps_lng` | Already agreed for collection; just absent from the draft. |
| `due: number` | `amount_due` | Mobile's comment is exactly right — never show it on the Collect Payment screen (anchoring bias). Keep hiding it; web shows it to admins only. |

---

## 4a. The customer name is on the row now (migration 045) — 2026-07-28

Answers mobile's `WEB_FIXES_NEEDED_FOR_SYNC.md`. **This was the only thing blocking Phase 1 read, and it is done.**

**The problem.** `collection_visits` and `purchase_orders` referenced the customer only by `client_id`. Migration 031 dropped the broad `"Authenticated read clients"` policy, and the scoped SELECT policies that replaced it (030) cover agents, managers, executives and tag-along participants — **not `collector` or `delivery`**. A phone logged in as a collector or driver could read the list row but could not resolve its `client_id` to a name, so every row rendered blank.

**The fix — new columns, not a new RLS policy on `clients`.** Deliberate: field roles have no business reading the customer master — contacts, assigned agent, lifecycle status — just to put a name on a stop. The admin already knows the name when they publish, so the name travels on the row and 030's scoping stays intact.

| Table | Added | Source at publish time |
| --- | --- | --- |
| `collection_visits` | `client_name TEXT` | `clients.company_name` |
| `collection_visits` | `area TEXT` | `clients.city` — collection has no admin-entered area field |
| `purchase_orders` | `client_name TEXT` | `clients.company_name` |

`purchase_orders.area` already existed (044) and is admin-entered on the form — untouched.

Both are **nullable and staying that way**: mobile pushes rows through its offline outbox, and NOT NULL would turn a missing denormalized field into a failed insert rather than a visibly incomplete row. Rows published before 045 are backfilled by the migration.

**Caveat mobile should know.** These are a point-in-time copy, not a live mirror. A customer renamed in `clients` afterwards keeps the old name on rows already published — correct for a trip ticket, which should say what it said on the day it was worked. Web keeps reading the joined `clients` row for anything current-state.

**Deployment.** Committed as `045_denormalize_client_on_lists.sql`; CI's `db push` applies it on merge to main. No hand-running in the SQL Editor is needed — and the file is idempotent (`ADD COLUMN IF NOT EXISTS`, backfill UPDATEs safe to repeat) if it ends up applied twice.

**Not blocking sync:** the "On the way" / claimed-en-route indicator is mock-only on mobile and has no schema behind it yet. The rules are now decided and specced for 046 — see §11.

---

## 5. Offline — this fits your existing architecture, don't build a parallel one

Mobile is already offline-first and the machinery is good. I read it rather than guessing, and the plan below deliberately reuses it.

**What exists:** a generic `outbox` (client-generated IDs, 5-state machine, `priority`, `next_attempt_at` backoff, `last_error`, dependency ordering), an `ENTITY_REGISTRY` where adding an entity is one entry (T-014 / ADR-022 #9), `entity-appliers.ts` for applying synced-down rows, and a **separate** `pending_uploads` lane for photos that is deliberately outside the outbox.

### 5a. Business rows ride the entity registry

`collection_visits` and `purchase_orders` become two more `EntityTableName` values with `ENTITY_REGISTRY` entries. Suggested config:

```ts
collection_visits: {
  remoteTable: 'collection_visits',
  priority: 20,                 // after clients(10)/meetings — these reference clients
  onConflict: 'id',
  applyRemoteRow: upsertSyncedCollectionVisit,   // new, in entity-appliers.ts
  dependencies: [{ table: 'clients', extractForeignKey: p => p.client_id ?? null }],
},
purchase_orders: { /* same shape, same priority tier */ },
```

Plus local SQLite tables in `db.ts` with the usual `sync_status` column and index, matching `clients`/`meetings`.

The `dependencies` mechanism matters here: a visit references a client, and if that client was itself created offline, its outbox row must push first. That's exactly what the meeting→client dependency already does.

### 5b. `pending_uploads` is meeting-shaped and needs generalising

This is the one real structural blocker, and it's worth flagging early:

```sql
CREATE TABLE pending_uploads (
  meeting_id TEXT NOT NULL,                                    -- ← too narrow
  kind TEXT NOT NULL CHECK (kind IN ('selfie','start','end')), -- ← too narrow
  ...
)
```

Collection and Delivery bring **six new photo kinds** that don't belong to a meeting:

| Module | Captures |
| --- | --- |
| Collection | `payment_photo`, `delivery_receipt_photo` |
| Delivery | `proof_photo`, `backload_photo`, `cod_photo`, `receiver_signature` |

Two options — your call, you own this code:

1. **Generalise** — rename `meeting_id` → `owner_id`, add `owner_type` (`'meeting' \| 'collection_visit' \| 'purchase_order'`), widen the `kind` CHECK. One lane, one drain loop, one retry policy.
2. **Parallel table** — leave the meeting lane untouched, add a second one.

I'd suggest (1). The existing lane's best idea — `storage_path` generated once and reused so a 409 "already exists" is treated as success, not failure — is exactly what the new kinds need too, and duplicating it invites the two copies to drift.

### 5c. GPS is stored at capture time, never at upload time

This already matches the established rule (GPS is captured at the moment the photo is taken, not at upload), and it matters more now that delivery has GPS.

The photo may sit in `pending_uploads` for hours before it uploads, possibly from a different location entirely. So **`gps_lat`/`gps_lng` go onto the business row immediately at capture**, and ride the outbox with the rest of the record — not attached to the photo upload. `lib/gps.ts`'s existing `Accuracy.Balanced` + timeout + `getLastKnownPositionAsync` fallback is the right tool and works offline already.

Consequence, stated plainly so it doesn't read as a bug later: an offline-captured stop has correct coordinates and a photo that arrives later. A stop whose GPS fell back to last-known has a slightly stale fix. Both are fine. A stop with **no** capture has no fix at all, and web shows "No pin".

---

## 6. What has **no** mobile impact

**`profiles.admin_scope`** (migration 024, already deployed). You'll see it in schema dumps. Ignore it.

It was deliberately modelled as a **new column rather than new role values**. The obvious design — `sales_admin`/`collection_admin`/`delivery_admin` in the role check constraint — would have pushed three unknown strings into a column mobile also reads, and that has bitten us once already: an `executive` role shipped from mobile on 2026-07-24 hard-crashed the web Users page. Keeping `role = 'admin'` means mobile's `UserRole` union and route guards need **no change at all**.

For reference: `TEXT NOT NULL DEFAULT 'all'`, constrained to `all|sales|collection|delivery`, with a second constraint enforcing that anything other than `role = 'admin'` stays `'all'`.

---

## 7. Route trails — making the line follow real roads

**Status: PROPOSED, not approved. Don't start this off the back of this doc.** Scope is Collection and Delivery only (§3).

### Why the line is straight today

One GPS fix per stop is all we capture. A three-stop day is three coordinates. Apps that draw real routes record a point every few seconds for the whole trip.

**This cannot be backfilled.** No web work recovers where a truck drove last Tuesday. Every day without it is a day with no trail, permanently — which is the argument for deciding sooner rather than later.

### Two options, and they are not the same thing

**A. Snap-to-road (inferred).** Send the existing stop coordinates to a routing engine (OSRM, Mapbox, Google Roads); draw the polyline it returns. Web-only, works today, applies retroactively to every past trip, cacheable forever since past trips never change.

But it draws the route they *could* have taken — whatever the router thinks is fastest. A detour, a two-hour stop, a trip somewhere else: none of it shows. **If the point is checking where people actually went, inference is worse than the dashed line** — it looks more trustworthy while being less true.

**B. Breadcrumb recording (real).** The phone records continuously while on shift. The only thing that produces an actual trail.

**Recommendation: B, with A only ever as a visually distinct fallback.** Web already encodes the convention — **solid = recorded, dashed = inferred or straight** — and whatever happens, an inferred path must never render as though it were recorded.

### What's missing on mobile today

| Thing | State |
| --- | --- |
| `expo-location` | ✅ present (`~57.0.6`) |
| `lib/gps.ts` | one-shot `getCurrentPositionAsync` — no continuous mode |
| Permissions requested | `requestForegroundPermissionsAsync` only |
| `expo-task-manager` | ❌ **absent** — required for background updates |
| `app.json` android | no `ACCESS_BACKGROUND_LOCATION`, no foreground-service permissions |
| `app.json` ios | `NSLocationWhenInUseUsageDescription` only — no Always key, no `UIBackgroundModes` |
| `expo-sqlite` | ✅ present — the buffer has somewhere to live |

⚠️ **Existing trap:** the `expo-location` plugin block in `app.json` already declares `locationAlwaysAndWhenInUsePermission`, but iOS `infoPlist` has no Always key and there's no background mode. Half-configured, and nothing uses it. Don't read its presence as "background is set up."

### Scope: record only between clock-in and clock-out

Not always-on. This bounds battery to paid hours, bounds data to one shift per person per day, uses a boundary that's already modelled (`clock_records`, with GPS, exists in both repos), and makes the App Store justification far easier to write.

**Raise this with the team and the client before building.** Continuously tracking staff location across a shift is materially different from recording where a photo was taken. Normal for logistics fleets, but collectors and drivers should be *told*, and the app should show a visible indicator while recording.

### Proposed storage (web owns migrations)

```sql
-- PROPOSED — not created yet, on purpose. See "Why there's no migration".
CREATE TABLE location_pings (
  -- Client-generated UUID so a retried batch is idempotent — same principle as
  -- the outbox's client-generated IDs. Without it, every retry duplicates the trail.
  id            UUID PRIMARY KEY,
  profile_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- When the FIX was taken on the device, not when the row arrived. These upload
  -- in offline batches, so created_at can be hours later and is useless for ordering.
  recorded_at   TIMESTAMPTZ NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  -- Metres. Lets web drop garbage fixes instead of drawing the trail through buildings.
  accuracy_m    REAL,
  speed_mps     REAL,
  -- Optional but genuinely useful in support: "the trail stops at 2pm" is
  -- answerable when you can see the phone was at 3%.
  battery_pct   SMALLINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX location_pings_profile_time_idx ON location_pings (profile_id, recorded_at DESC);

ALTER TABLE location_pings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users insert own pings" ON location_pings
  FOR INSERT TO authenticated
  WITH CHECK (profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Admins read all pings" ON location_pings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles
                 WHERE user_id = auth.uid() AND role IN ('admin','superadmin')));
```

Deliberately **not** foreign-keyed to a shift, a PO, or a visit — pings are a raw stream keyed on person + time, and web joins them to a trip by time window. A stream that depends on tables nobody has built yet is a stream nobody can start collecting.

Note there's no policy letting a field user read their own pings. If mobile wants to show a driver their own trail, that needs one added — say so rather than working around it.

**Volume:** at a 50 m distance filter, an 8-hour shift is roughly **1,000–1,500 points ≈ 40–60 KB per person per day**. Ten staff for a year is well under a gigabyte. Don't pre-optimise into rollup tables.

### Recording

```ts
// Distance-driven, not time-driven: a truck parked an hour at a stop should
// produce ~0 points, not 120 identical ones. timeInterval is the moving ceiling.
await Location.startLocationUpdatesAsync(SHIFT_TRACKING_TASK, {
  accuracy: Location.Accuracy.Balanced,   // same reasoning as lib/gps.ts — no A-GPS dependency
  distanceInterval: 50,                   // metres
  timeInterval: 30000,                    // ms, Android hint
  pausesUpdatesAutomatically: true,       // iOS: pauses when stationary
  activityType: Location.ActivityType.AutomotiveNavigation,
  foregroundService: {
    notificationTitle: 'Recording your route',
    notificationBody: 'Your location is recorded while you are clocked in.',
  },
});
```

Android's foreground-service notification is **mandatory**, and it doubles as the honest always-visible "you are being recorded" indicator. Don't suppress it.

Android also won't grant background location in the same prompt as foreground: call `requestForegroundPermissionsAsync()`, then `requestBackgroundPermissionsAsync()` — which on Android 11+ sends the user to Settings rather than prompting. That needs a real explainer screen first, or it gets denied. And **clock-in must still work if permission is refused** — losing a trail is acceptable, blocking someone from starting their shift is not.

### Offline buffering — its own lane, not the outbox

Pings should **not** go through `outbox`. That lane is built for business writes with per-row priority, dependency ordering, and per-row error reporting; pushing 1,500 low-value rows a day through it would swamp the queue and starve the writes that matter. Your codebase already sets the precedent both ways — `pending_uploads` is deliberately outside the outbox, and the `sync_audit` lane uses `priority: 900` specifically so it never jumps ahead.

So: a local `pending_pings` table, drained by its own loop, batched ~100 rows per request, deleted only after acknowledgement, retried with backoff. The client-generated UUID primary key makes a duplicated batch a no-op — upsert with `ignoreDuplicates` on `id` so a partially-landed batch doesn't fail whole.

This is a genuinely good fit for offline: a full day out of signal is ~60 KB buffered locally, flushed when the driver gets back in range. Nothing is lost, and unlike a business write there's no user waiting on it.

### Edge cases that will actually happen

| Case | Handling |
| --- | --- |
| Forgot to clock out | Auto-stop after **12 h** so a phone doesn't record all night. Web treats a 12 h trail as suspect. |
| Permission revoked mid-shift | Task stops silently. Detect on next foreground, tell the user, don't crash. |
| Phone killed by OEM battery manager | **Xiaomi / Oppo / Vivo / Huawei aggressively kill background tasks.** Biggest reliability risk — check what handsets field staff actually carry before promising complete trails. |
| Dead zone all day | Buffer grows locally, flushes later. Expected, not an error. |
| Battery dies | Trail just ends; `battery_pct` on the last ping explains why. |
| Device clock wrong | `recorded_at` is device time. Web discards pings dated in the future or well before the shift. |

### Why there's no migration yet

Web's `.github/workflows/deploy-migrations.yml` runs `supabase db push` against the **shared** Supabase project on merge to main. Committing a location-pings migration speculatively would deploy a table to the live database that nothing writes to and nobody agreed on. The SQL above is ready; it becomes a migration the day the plan is approved — as **046**, since 045 went to the denormalization in §4a.

---

## 8. Action items for mobile

**Priority 1 — cheap now, expensive later. Do whenever F-007 is next touched:**

- [ ] Drop `'followup'` and `'backload'` from the delivery status union → `'pending' | 'delivered' | 'failed'`
- [ ] Delete `day?: number` and any follow-up countdown built on it
- [ ] Add `'counter'` to `PaymentMethod`; switch the union to lowercase values
- [ ] Replace `time?: string` with real timestamps — `visited_at` (collection), `time_in`/`time_out` (delivery). **Highest value: collection trips are unorderable without it.**
- [ ] Switch mock `id`s from `number` to UUID strings
- [ ] Drop `items` from the PO shape

**Priority 2 — when the Collect Payment and Deliver PO flows get built:**

- [ ] Add `collection_visits` + `purchase_orders` to `EntityTableName` / `ENTITY_REGISTRY` with a `clients` dependency (§5a), plus local tables and appliers
- [ ] Generalise `pending_uploads` to carry non-meeting owners and the six new photo kinds (§5b)
- [ ] Capture GPS alongside the **delivery** proof photo and write it to the business row at capture time (§2, §5c)
- [ ] Same for the collection payment photo
- [ ] Write `collector_id` / `driver_id` at the moment of collection/delivery, never in advance
- [ ] Capture both `time_in` and `time_out` per delivery stop, **including on failed stops**
- [ ] Enforce both collection captures before accepting "✓ Collected"; enforce the backload photo before accepting a failed delivery

**Priority 3 — decisions, not code:**

- [ ] Read §7 and tell me whether route trails are wanted, and whether the client is comfortable with shift-bounded recording
- [ ] Confirm the table shapes in §4 before either side writes a migration — **web owns migrations**, so tell me and I'll write them

---

## 9. Sequencing

1. ~~Web writes the migrations~~ — **done**, 043 + 044 on this branch, unmerged.
2. **Agree §4 and the table shapes.** Still the cheap moment: nothing is deployed, so a column rename costs a text edit rather than a data migration.
3. **Merge → the tables deploy** to the shared project, empty.
4. ~~Web wires its admin pages to the real tables~~ — **done.** Collection, Delivery, the dashboards, maps and reports all read the live tables now; `lib/mock/data.ts` is no longer imported anywhere.
5. **Admin publishes a real list on web**, mobile reads it and works it down. That is the first genuine end-to-end test.
6. **Route trails** separately, on their own timeline, if approved.

⚠️ Step 3 pushes to the **shared** Supabase project, so it hits the database mobile develops against immediately. Purely additive (new tables, new buckets, new helper functions — nothing existing is altered), but I'll ping before merging.

On step 4: "Add Store" and "Add PO" now insert real rows via `lib/hooks/use-collection.ts` and `lib/hooks/use-delivery.ts`, and removing an unworked row deletes it. Until the migrations are merged those calls will fail against the missing tables — which is expected, and surfaces as a visible error banner rather than a silent no-op.

### What the migrations give you

| | |
| --- | --- |
| Tables | `collection_visits`, `remittances`, `purchase_orders`, `cod_remittances` |
| Buckets | `collection-proofs`, `delivery-proofs` (public read + an explicit INSERT policy — public alone does **not** grant upload; that gotcha cost us a day on `meeting-photos`) |
| RLS | Field roles read the **whole day's list** and may claim any unclaimed row, but cannot reassign one to someone else, and cannot INSERT or DELETE — the admin publishes the list |
| Scoped admins | `admin_scope` is now enforced at the data layer, not just in navigation — a Delivery Admin cannot read collection rows through the API |
| Photo columns | All nullable **on purpose** — mobile's deferred upload lane means URLs arrive after the row, and "closed out without a required capture" is a hole web has to show rather than reject |

## 10. Open questions

1. **Does the driver's app show the COD amount?** Web says **yes** — unlike collection's `amount_due`, a COD figure is the fixed price of goods being handed over, not a negotiable balance. It's the one place the two modules deliberately differ; confirm mobile agrees.
2. **`pending_uploads`: generalise or parallel table?** (§5b) Your call — I lean generalise.
3. **Can a collector or driver see their own trail on the phone?** Changes the RLS policy set. Currently specced as no.
4. **How long are trails kept?** Nobody has asked, which means nobody has thought about it. I'd suggest 90 days.
5. **Are trails for verification or route optimisation?** If optimisation, the odometer/fuel block on the paper Trip Report (still unmodelled) matters more than metre-accurate trails.

*(The claimed-state questions that sat here are settled — see §11.)*

---

## 11. The "On the way" claimed state — built, migration 046

Mobile's list screens show an en-route indicator that was mock-only; nothing in 043/044 backed it. Decisions below are from Dev2 + the business on **2026-07-28**, and `046_claim_stops.sql` implements them. **Mobile can now write real claims** — see "What mobile does" at the end of this section.

### The rules

| Question | Decision |
| --- | --- |
| Soft hint or hard lock? | **Hard lock.** A claimed stop cannot be worked by anyone else. |
| How many claims per person? | **Exactly one.** No multiple claims, no hoarding. |
| Does a claim expire? | **No.** Claims do not time out. |
| Who can cancel? | **The claimer, and any admin.** Nobody else. |
| Does the admin see who claimed what? | **Yes** — on the day list, alongside the row. |

**Why a hard lock doesn't break the shared-list rule.** The concern was that locking turns the published pool into back-door assignment. The one-claim limit is what prevents that: you cannot reserve the profitable half of the list, so a claim means only "I am driving to this one stop right now" — which is what the indicator always meant. The pool stays shared.

### Schema

**A new `claimed_by` / `claimed_at`, NOT a reuse of `collector_id` / `driver_id`.** This is deliberate and it keeps 043/044 intact: `collection_visits_pending_is_unworked` names `collector_id`, `amount_collected`, `visited_at`, so a new column isn't covered by it and **the constraint does not need relaxing** (contrary to the original sketch in mobile's `WEB_FIXES_NEEDED_FOR_SYNC.md`). `collector_id` keeps meaning *who worked it*; `claimed_by` means *who is en route*. One column, one meaning.

One claim per person is enforced by the database, not by app logic:

```sql
CREATE UNIQUE INDEX collection_visits_one_active_claim
  ON collection_visits (claimed_by)
  WHERE claimed_by IS NOT NULL AND status = 'pending';

CREATE UNIQUE INDEX purchase_orders_one_active_claim
  ON purchase_orders (claimed_by)
  WHERE claimed_by IS NOT NULL AND status = 'pending';
```

Two things fall out of that predicate for free:

- **Races resolve correctly without realtime.** Two phones claiming the same stop: one wins, the other gets a unique violation to handle. The lock is correct even if the other phone doesn't hear about it until its next refresh. Worth knowing that there is currently **no realtime anywhere in the web repo** — no `.channel()`, no `postgres_changes` — so treating it as a later UX improvement rather than a prerequisite saves building that machinery now.
- **Completion frees the slot automatically.** Scoping to `status = 'pending'` means the row drops out of the index the moment it becomes `collected`/`delivered`/`failed`. No release logic on the happy path.

### RLS

Today any field-role user may update any unclaimed row. That becomes:

- **Claim:** a collector/driver may set `claimed_by` to themselves on a `pending` row where `claimed_by IS NULL`.
- **Work:** only `claimed_by = self` may write the outcome columns on a claimed row.
- **Cancel:** `claimed_by = self`, or an admin (who may clear anyone's).

### The one edge case, and why it's acceptable

The business rule is **whole-day only** — a stop is collected, rescheduled or failed *that day*; a failed delivery is a backload, not a follow-up. So a claim outliving its day shouldn't arise.

Worth being precise, though: nothing enforces that in the data. There is no `pg_cron` job and no scheduled function anywhere in the migrations, so a row *can* sit at `status = 'pending'` past its `scheduled_for` if someone claims a stop at 4pm and simply goes home. Under "one claim, no expiry" that person cannot claim anything the next morning until the stale one is cleared.

This does not need an expiry rule to fix — admin cancellation already covers it, and because the admin now sees claims on the day list they will see it. The only ask: **the web board should visually flag a claim on a past-dated pending row**, so clearing it is obvious rather than something an admin has to go looking for. UI, not schema.

### A third column mobile must know about: `claimed_by_name`

Same trap as 045's `client_name`, and it would have bitten in exactly the same way. A collector can read only their **own** `profiles` row (migration 003) — there is no policy letting field roles read each other. So `claimed_by` alone is unresolvable on the phone: a stop held by someone else would read "taken by ?".

046 therefore denormalizes `claimed_by_name` alongside `claimed_by`/`claimed_at`, written at claim time. A CHECK constraint keeps the three in step — all set, or all null. If mobile only ever needs "mine vs somebody else's", compare `claimed_by` to your own profile id and ignore the name.

### What mobile does

**To claim:** on a `pending` row where `claimed_by IS NULL`, set all three of `claimed_by` (self), `claimed_at` (now), `claimed_by_name` (own full name).

**Handle the unique violation.** If two phones claim the same stop, the loser gets Postgres error **23505** on `collection_visits_one_active_claim` / `purchase_orders_one_active_claim`. That is not a bug to retry blindly — it means either someone beat you to this stop, or **you already hold a different one**. The second case is the one worth a clear message, because it is the one-claim rule doing its job: "Finish or release your current stop first."

**To release:** null all three. RLS allows the claimer; the admin can clear anyone's from the web board.

**Completion needs no release.** Writing the outcome (`collected` / `delivered` / `failed`) drops the row out of the index and frees your slot automatically. Leave `claimed_by` populated — it is kept as history on purpose.

**Offline note:** a claim is a normal row update and rides the existing outbox. Be aware it can therefore fail on flush, long after the tap, if someone else claimed the stop while the phone was out of signal. That is inherent to a hard lock plus offline — worth a visible "your claim didn't stick" path rather than a silent revert.

### Sequencing

045 and 046 land together. 046 is the first feature riding on top of the sync, so if a claim misbehaves, confirm the plain read works first — that isolates it fast.

---

## 12. Reply to `COLLECTION_DELIVERY_STATUS_MOBILE.md` — 2026-07-31

Written after reading mobile's status doc at its 2026-07-28 revision plus commit `938b76d` (Phase 2b/2c). Two of the three things it asks web for were already done when it was written; the third is done now.

### ❌ "The one thing waiting on web now: the admin board doesn't display claims yet"

**This has been shipped since commit `c9e0bf8`** — the same commit that unblocked the sync and added claiming, so it landed *with* 046 rather than after it. The status doc's TL;DR is reading a stale snapshot; please drop it, because it is currently the headline item and it is blocking nothing.

What has been on the board the whole time, both modules:

- `claimed_by_name` and `claimed_at` on the row, as an **"On the way · {name} · 12m"** line with the age ticking up.
- A **release control** on every claimed row, wired to an admin update that nulls all three columns together (the CHECK in 046 rejects a partial claim).
- The §11 ask — *"the web board should visually flag a claim on a past-dated pending row"* — as a distinct red treatment, not the same styling as a live claim.

### ✅ Improved on 2026-07-31, same area

Since the flagging in §11 was per-row only, an admin still had to *find* the stale row on a day card they had stopped scrolling to. Now:

- A claimed row is **tinted with a coloured leading rule** — brand for a live claim, red for a stale one — so the lock is legible while scanning rather than only on the row being read.
- Each day header carries a **"⚠ N stuck"** badge and a one-line explanation of *why* it matters (the holder cannot claim anything new until it is released). That is the one-claim rule's consequence, which is not obvious from the row alone.
- The release button is an **opening padlock**, not the navigation arrow it shared with the indicator. Same glyph for "a claim exists" and "press to remove the claim" made the action read as decoration.

### ✅ "The admin board should show submitted remittances and reconcile them"

**Display** has been there since the module shipped: both `remittances` and `cod_remittances` get a card each with destination, amounts, computed variance, a signature-missing warning, and a CSV export column.

**Reconciliation is now built** (2026-07-31). A `submitted` row offers **Reconcile** and **Flag variance**; a settled row offers **Reopen**, so a misclick isn't permanent. Both write straight to `status`.

Worth stating explicitly, since it drove the design: **web is the only thing that can ever move that column.** 043/044 give field roles INSERT and SELECT on the remittance tables and no UPDATE policy at all — which mobile correctly worked around by putting photo URLs in the insert. The flip side is that `status` would have sat on its default forever. It doesn't now.

Both actions are always offered on a submitted row; the amounts only decide which is styled as the default. Deriving the status from the arithmetic would be wrong in both directions — an admin legitimately reconciles a row whose totals disagree (the gap was explained and accepted), and legitimately flags one whose totals agree (the signature is missing, or the proof doesn't match). The arithmetic is evidence; the status is a judgement.

### ✅ Phase 2b/2c landed cleanly — proofs are now readable, not just present

Confirmed against live data on 2026-07-31: real captures from the phone are arriving and rendering in the admin — proof-of-delivery, COD payment, and a receiver signature on `PO-1239`, and a signature on the one COD remittance. The column names in `938b76d` match what web reads.

The thumbnails predate the uploads working, and were sized to answer *"did the capture arrive?"* — the only question worth asking while every URL was null. Now that they hold real images the office's question is *"what does it say?"*, and a GCash confirmation screenshot is unreadable at tile size. Every capture is therefore **clickable to a full-size view**, captioned with who brought it back and when. Signatures render contained on white rather than cropped to fill, so the loops aren't cut off.

No action needed from mobile — this is web catching up to work you had already done.

### What web still owes

Nothing outstanding from the current mobile status doc. The next items on this side are our own: verifying the Collection page against a collection-scoped admin account (it was exercised end-to-end on Delivery only, since the test account is `admin_scope = 'delivery'`), and the trip-list ownership question in §10 that is still unanswered.

### One thing worth a second look on mobile

`sequence_no` is assigned as `MAX(sequence_no) + 1` over the driver's whole history with no day in the `WHERE` clause, so it never resets — a driver's second day starts at #4. Web now renumbers from the position within each (driver, day) group and uses the stored value only as an ordering key, which is correct for the board either way. Flagging it because anything on the phone that shows the raw number to a driver will drift further every day.
