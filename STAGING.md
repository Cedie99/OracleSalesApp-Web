# Staging environment & git workflow

This is the everyday guide for working with **staging**. Read the first two
sections once, then use the **Daily workflow** as your checklist.

---

## The two environments

| | `main` branch | `staging` branch |
|---|---|---|
| **Purpose** | Real production app | Testing before real users see it |
| **Who uses it** | Real staff / stores | Devs + testers |
| **Web URL** | *production URL* | https://oracle-sales-app-web.vercel.app |
| **Supabase project** | production | staging (`xhxjbzesuzprwdelrdwh`) |
| **Data** | Real, live — never break it | Fake/test — break it freely |

**The golden rule:** every change goes through **`staging` first**, gets tested,
then is promoted to **`main`** (production).

```
feature branch  →  PR into staging  →  test on staging  →  PR staging into main  →  production
```

---

## Daily workflow

### 1. Start from an up-to-date `staging`

```bash
git checkout staging
git pull
git checkout -b feature/short-description   # your working branch
```

> Always branch off `staging`, not `main`. Name it something clear, e.g.
> `feature/collection-report`, `fix/login-redirect`.

### 2. Do the work and commit

```bash
git add -A
git commit -m "feat: short description of what changed"
```

> Keep commits focused. Use Conventional Commit prefixes: `feat:`, `fix:`,
> `style:`, `refactor:`, `chore:`.

### 3. Push your branch

```bash
git push -u origin feature/short-description
```

### 4. Open a Pull Request **into `staging`**

- On GitHub, open a PR with **base = `staging`**, compare = your branch.
- ⚠️ Make sure the base is **`staging`**, not `main`. (GitHub defaults to
  `main` — change it.)
- Get it reviewed/merged.

### 5. Test on the staging site

- Merging into `staging` auto-deploys to
  **https://oracle-sales-app-web.vercel.app**.
- Open it, log in, and verify your change against the staging data.

### 6. Promote to production

When it's verified on staging:

- Open a PR with **base = `main`**, compare = **`staging`**.
- Merge it → production auto-deploys.

---

## Migrations (database changes)

If your change adds a file under `supabase/migrations/`:

- **Merging to `staging`** auto-applies the migration to the **staging**
  database (via the `Deploy Supabase migrations` GitHub Action).
- **Merging `staging` → `main`** auto-applies it to **production**.

So migrations are always **tested on staging before they touch production** —
that is the whole point of this setup. You do **not** need to run
`supabase db push` by hand for normal work.

> Manual fallback (only if you must apply to staging without a merge):
> `npx supabase link --project-ref xhxjbzesuzprwdelrdwh` then
> `npx supabase db push`.

---

## Keeping `staging` healthy

- **Don't commit directly to `main`.** It should only ever receive merges from
  `staging`.
- **If `staging` drifts behind `main`** (e.g. a hotfix went straight to prod),
  sync it back:
  ```bash
  git checkout staging
  git pull
  git merge main
  git push
  ```
- **Never point local dev at production** for destructive testing. Use staging.

---

## Reference: environment variables

The web app reads exactly three values, set **per Vercel project**:

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public — the project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public — browser/mobile key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** — server-only admin key |

- **Staging Vercel project** → staging Supabase values (Production + Preview envs).
- **Production Vercel project** → production Supabase values.

GitHub Actions secrets used by the migrations workflow:

| Production | Staging |
|---|---|
| `SUPABASE_PROJECT_ID` | `STAGING_SUPABASE_PROJECT_ID` |
| `SUPABASE_ACCESS_TOKEN` | `STAGING_SUPABASE_ACCESS_TOKEN` |
| `SUPABASE_DB_PASSWORD` | `STAGING_SUPABASE_DB_PASSWORD` |

---

## Rebuilding staging from scratch (rare)

If you ever recreate the staging Supabase project, the migrations do **not**
fully reproduce production on their own — a couple of objects were hand-applied
to prod and never captured in a migration. After `supabase db push`, you must
also add:

1. **`public.is_admin()`** — otherwise the push fails at migration `028`:
   ```sql
   create or replace function public.is_admin()
   returns boolean language sql stable security definer set search_path to 'public'
   as $$ select exists (select 1 from public.profiles
     where user_id = auth.uid() and role in ('admin','superadmin')) $$;
   ```
2. **`meetings.end_gps_lat` / `end_gps_lng`** — otherwise the dashboard errors:
   ```sql
   alter table public.meetings
     add column if not exists end_gps_lat double precision,
     add column if not exists end_gps_lng double precision;
   ```

Then bootstrap the first super admin (there's no in-app way to create the very
first one):

1. Supabase → **Authentication → Add user** (check *Auto Confirm*), copy the UID.
2. SQL Editor:
   ```sql
   insert into public.profiles
     (user_id, full_name, email, role, admin_scope, team_id, is_active)
   values ('THE-UID', 'Your Name', 'you@example.com', 'superadmin', 'all', null, true);
   ```

After that, all other users are created through the app's **Users** page.
