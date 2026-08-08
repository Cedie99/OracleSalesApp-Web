-- ============================================================================
-- 069 — Collection: the collector's write path for the two "additional" acks
--
-- Companion to 068. That migration added is_additional + additional_received_at
-- + additional_seen_at, but nothing can WRITE the two timestamps yet: 043's
-- "Collectors work the list" UPDATE policy carries
--     WITH CHECK (collector_id = current_profile_id())
-- and additional_received_at is stamped the moment the row syncs down to a
-- phone — BEFORE anyone claims it, while collector_id is still NULL — so that
-- policy rejects the write. This migration opens exactly that write, and only
-- that write.
--
-- ── Why a function, and not another RLS policy ──────────────────────────────
-- The obvious move — a broader collector UPDATE policy — is the wrong one, for
-- two reasons that both bite:
--
--   1. RLS gates ROWS, not COLUMNS. A policy permissive enough to let a
--      collector touch an unclaimed row is permissive enough to let them rewrite
--      amount_due or flip status on it. A policy cannot say "only these two
--      columns may change".
--   2. Policies are OR'd (permissive). Any new collector UPDATE policy UNIONs
--      with "Collectors work the list" and can only WIDEN it, never narrow — so
--      even a carefully-scoped one loosens the table as a whole.
--
-- So the write path is two SECURITY DEFINER functions instead. Each one stamps
-- exactly ONE column, only on an is_additional row, only ONCE (COALESCE, so a
-- retry — or a second phone syncing the same row — is a silent no-op, never an
-- overwrite), and only when the caller is a collector. Running as owner, they
-- reach an unclaimed row without any change to table RLS. 043's policies are
-- left exactly as they are.
--
-- ── ⚠️ MOBILE CONTRACT ──────────────────────────────────────────────────────
-- Mobile stamps these by CALLING THESE FUNCTIONS, not with a direct .update():
--     supabase.rpc('mark_additional_received', { p_visit_id })
--     supabase.rpc('mark_additional_seen',     { p_visit_id })
-- A direct UPDATE on the columns still hits 043's policy and still fails — that
-- is deliberate, and is the whole reason this file exists. Keep this in sync
-- with the mobile repo's ADDITIONAL_COLLECTION_CONTRACT.md before either side
-- ships its half.
--
-- Purely additive: two new functions, their grants, nothing altered or dropped.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- mark_additional_received — "the row reached a collector's phone" (Delivered ✓)
--
-- Stamped before the store is claimed, by whichever phone syncs it first. No
-- collector_id check: the list is a shared pool and delivery is about the row
-- arriving, not about who eventually works it. Idempotent via COALESCE, so the
-- first sync wins and every later one returns the same timestamp unchanged.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_additional_received(p_visit_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ts timestamptz;
BEGIN
  -- Only a collector acknowledges. An admin already sees the row; anyone else
  -- has no business stamping it. 42501 = insufficient_privilege, which the
  -- client surfaces as a permission error rather than a generic 500.
  IF public.current_user_role() <> 'collector' THEN
    RAISE EXCEPTION 'Only a collector may acknowledge an additional store'
      USING ERRCODE = '42501';
  END IF;

  UPDATE collection_visits
     SET additional_received_at = COALESCE(additional_received_at, NOW())
   WHERE id = p_visit_id
     AND is_additional
  RETURNING additional_received_at INTO v_ts;

  -- NULL means either no such row or a non-additional one — a no-op, not an
  -- error. Mobile can treat NULL as "nothing to acknowledge".
  RETURN v_ts;
END;
$$;

COMMENT ON FUNCTION public.mark_additional_received(uuid) IS
  'Collector-only. Stamps collection_visits.additional_received_at once (Delivered), on an is_additional row, before it is claimed. Call via RPC — a direct UPDATE is rejected by 043''s collector policy. See migration 069.';

-- ----------------------------------------------------------------------------
-- mark_additional_seen — "a collector opened the store's screen" (Viewed)
--
-- The stronger signal: not just that the row arrived, but that a human looked
-- at it. Same shape as received — collector-only, additional-only, write-once.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_additional_seen(p_visit_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ts timestamptz;
BEGIN
  IF public.current_user_role() <> 'collector' THEN
    RAISE EXCEPTION 'Only a collector may acknowledge an additional store'
      USING ERRCODE = '42501';
  END IF;

  UPDATE collection_visits
     SET additional_seen_at = COALESCE(additional_seen_at, NOW())
   WHERE id = p_visit_id
     AND is_additional
  RETURNING additional_seen_at INTO v_ts;

  RETURN v_ts;
END;
$$;

COMMENT ON FUNCTION public.mark_additional_seen(uuid) IS
  'Collector-only. Stamps collection_visits.additional_seen_at once (Viewed), on an is_additional row. Call via RPC — a direct UPDATE is rejected by 043''s collector policy. See migration 069.';

-- ----------------------------------------------------------------------------
-- Grants. A SECURITY DEFINER function defaults to EXECUTE for PUBLIC, which
-- would let the anon role call it — lock that down to signed-in users. The
-- collector check inside does the finer gate; this just keeps the door shut to
-- unauthenticated callers.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mark_additional_received(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_additional_seen(uuid)     FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_additional_received(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_additional_seen(uuid)     TO authenticated;
