-- ============================================================================
-- 101 — Change stamps + indexes for the web's background auto-refresh
--
-- WHY: every admin page on the web is a client component that reads its rows
-- once on mount and then never again. An admin watching the Collection board
-- while collectors are working it, or the Approvals queue while agents are
-- filing requests, was looking at whatever the table said when the tab opened.
-- lib/hooks/use-auto-refresh.ts now re-reads in the background — and this
-- migration is what stops that from being expensive.
--
-- THE SHAPE OF THE PROBLEM: naively polling means re-running the real query
-- (`clients` with its agent join, `collection_visits` with its payments) every
-- minute, per open tab, forever — almost always to receive the identical rows
-- back. What the browser actually needs to know is one bit: "has anything
-- changed since I last looked?" So each hook first asks its table for
--
--   select <stamp> from <table> order by <stamp> desc limit 1   -- + exact count
--
-- one row over the wire, and only re-runs the real query when the answer
-- differs. Both halves of that answer are load-bearing: the timestamp alone
-- cannot see a DELETE (nothing moves forward when a row disappears), and the
-- count alone cannot see an UPDATE.
--
-- WHAT THIS MIGRATION DOES, THEREFORE:
--
--   1. Gives every polled table an `updated_at` that actually moves on UPDATE.
--      Several tables only had `created_at`, which is not the same thing — a
--      remittance being reconciled, an edit request being approved, or a
--      collector's photo landing through the deferred-upload lane are all
--      in-place updates that `created_at` cannot see. Without this the probe
--      would report "unchanged" while the row on screen was wrong, which is
--      worse than not refreshing at all.
--
--   2. Indexes each stamp column DESC, so `order by <stamp> desc limit 1` is an
--      index read rather than a sort of the whole table. This is the difference
--      between a probe that costs nothing and one that costs more than the query
--      it was meant to replace.
--
-- MOBILE, PLEASE NOTE: this is additive only — new nullable-then-defaulted
-- columns and new indexes. No column is renamed, retyped or dropped, and no
-- existing trigger changes behaviour. The only thing mobile will observe is an
-- extra `updated_at` field coming back on `select *` from the tables listed
-- below, which the offline outbox does not need to write (the trigger maintains
-- it server-side; an explicit value sent by a client is overwritten, exactly as
-- it already is on `clients`, `collection_visits` and `purchase_orders`).
--
-- BACKFILL: existing rows take their `created_at` rather than the migration's
-- own clock, so the historical ordering the index sees matches reality instead
-- of showing every pre-existing row as written at deploy time.
--
-- `update_updated_at()` is the trigger function from 001, already in use on
-- clients (001), collection_visits (043) and purchase_orders (044). This
-- migration reuses it rather than defining a second one.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. `updated_at` where it was missing
--
-- Added in three steps rather than as one `add column ... not null default
-- now()`: `now()` is volatile, so a single-statement default would rewrite the
-- whole table, and every existing row would claim to have been written at
-- deploy time. Add, backfill from created_at, then attach the default.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  polled_tables text[] := array[
    -- Sales
    'profiles', 'teams', 'meetings', 'clock_records', 'client_edit_requests',
    -- Collection
    'collection_payments', 'remittances',
    -- Delivery
    'cod_payments', 'cod_remittances'
  ];
begin
  foreach t in array polled_tables loop
    -- Skip anything not present on this database. The web and mobile repos
    -- share one instance and have not always shared a migration history, so a
    -- table can legitimately be missing here without that being an error.
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    execute format('alter table public.%I add column if not exists updated_at timestamptz', t);

    -- Idempotent: a re-run finds nothing null left to fill.
    execute format(
      'update public.%I set updated_at = coalesce(created_at, now()) where updated_at is null',
      t
    );

    execute format('alter table public.%I alter column updated_at set default now()', t);
    execute format('alter table public.%I alter column updated_at set not null', t);

    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function update_updated_at()',
      t || '_updated_at', t
    );
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 2. The stamp indexes
--
-- One per table the web polls, on exactly the column lib/hooks/use-auto-refresh
-- names for it. Keep the two in step: a hook watching a column with no index
-- here turns a free probe into a full sort on every tick.
--
-- Not repeated below because they already exist:
--   notifications (created_at DESC)   — 047
--   admin_audit_logs (occurred_at DESC) — 096
-- ----------------------------------------------------------------------------

-- Sales
create index if not exists idx_clients_updated_at
  on public.clients (updated_at desc);
create index if not exists idx_profiles_updated_at
  on public.profiles (updated_at desc);
create index if not exists idx_teams_updated_at
  on public.teams (updated_at desc);
create index if not exists idx_meetings_updated_at
  on public.meetings (updated_at desc);
create index if not exists idx_clock_records_updated_at
  on public.clock_records (updated_at desc);
create index if not exists idx_client_edit_requests_updated_at
  on public.client_edit_requests (updated_at desc);

-- Collection
create index if not exists idx_collection_visits_updated_at
  on public.collection_visits (updated_at desc);
create index if not exists idx_collection_payments_updated_at
  on public.collection_payments (updated_at desc);
create index if not exists idx_remittances_updated_at
  on public.remittances (updated_at desc);

-- Delivery
create index if not exists idx_purchase_orders_updated_at
  on public.purchase_orders (updated_at desc);
create index if not exists idx_cod_payments_updated_at
  on public.cod_payments (updated_at desc);
create index if not exists idx_cod_remittances_updated_at
  on public.cod_remittances (updated_at desc);

-- Quota configuration (Settings). Low churn, polled slowly, but the probe still
-- wants the index so "nothing changed" stays the cheap answer.
create index if not exists idx_cutoff_periods_updated_at
  on public.cutoff_periods (updated_at desc);
create index if not exists idx_mca_attributed_at
  on public.meeting_cutoff_attributions (attributed_at desc);
create index if not exists idx_holidays_created_at
  on public.holidays (created_at desc);
create index if not exists idx_cutoff_period_changes_changed_at
  on public.cutoff_period_changes (changed_at desc);

-- `quota_settings` is watched too, but holds a single row — the planner reads it
-- whole either way, so an index there would be dead weight.
