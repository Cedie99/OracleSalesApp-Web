# Sales Admin

A Next.js 16 admin dashboard for managing sales teams, clients, meetings, and approvals.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS v4, shadcn/ui |
| Database & Auth | Supabase |
| Tables | TanStack Table v8 |
| Charts | Recharts v3 |
| Notifications | Sonner |
| Date Handling | date-fns v4 |
| Excel Export | xlsx |

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [npm](https://www.npmjs.com/) (included with Node.js)
- Git

---

## Local Setup

### 1. Clone the Repository

```bash
git clone <repo-url>
cd sales-admin
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy `.env.example` to `.env.local` and fill it with the **staging** Supabase
values (ask the project lead). Local dev runs against staging by default —
production has real users, so you never point at it by accident.

If you also need to debug against production, copy `.env.example` to
`.env.prod.local` with the production values. See [STAGING.md](STAGING.md) →
*Local development* for the full explanation.

### 4. Start the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The server
prints a banner on startup naming the database it is connected to.

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server at `http://localhost:3000`, against **staging** |
| `npm run dev:prod` | Same, but against **production** — read-only debugging |
| `npm run env:check` | Validate both env files without starting a server |
| `npm run build` | Build for production |
| `npm start` | Run the production build |
| `npm run lint` | Run ESLint |
| `npm run mobile:status` | Sync latest mobile app source into `MOBILE_STATUS.md` |

---

## Mobile App Coordination

This web admin shares the same Supabase project with the companion mobile app ([OracleSalesApp-Mobile](https://github.com/VinceCarter12/OracleSalesApp-Mobile)). Both apps read and write the same tables, so changes to the database schema or shared data contracts can affect both sides.

`MOBILE_STATUS.md` in this repo contains the latest commits and full source code fetched from the mobile repo's `main` branch. Use it to understand what tables, columns, and data the mobile app depends on before making changes.

> **Before doing any of the following, run `npm run mobile:status` and review `MOBILE_STATUS.md` first:**
> - Adding, renaming, or removing Supabase tables or columns
> - Changing RLS policies
> - Modifying shared types or enums (e.g., customer types, meeting outcomes)
> - Any work that touches data the mobile app reads or writes

The file is updated on demand — it only reflects the mobile repo's state as of the last time the script was run. Commit the updated `MOBILE_STATUS.md` after running the script so the rest of the team stays in sync.

---

## Git Workflow

Work flows through **`staging` first, then `main`**. `main` is the live app real
staff use, so nothing reaches it that hasn't run on staging first.

```
feature branch  →  PR into staging  →  test on staging  →  PR staging into main  →  production
```

[STAGING.md](STAGING.md) is the full guide, including how to run local dev
against staging. This section is the short version.

### Core Rules

1. **`main` is production.** It only ever receives merges from `staging`.
2. **One branch per task or feature.** Always branch off `staging`, not `main`.
3. **Keep branches short-lived.** Aim to merge within 1–3 days to avoid drift.
4. **All merges go through a Pull Request.** At least one teammate must review before merging.
5. **Delete the branch after it is merged.**

### Branch Naming

| Type | Format | Example |
|---|---|---|
| Feature | `feature/<short-description>` | `feature/meeting-gps-map` |
| Bug fix | `fix/<short-description>` | `fix/approval-status-reset` |
| Chore / config | `chore/<short-description>` | `chore/update-dependencies` |

### Day-to-Day Flow

```bash
# 1. Start from an up-to-date staging
git checkout staging
git pull origin staging

# 2. Create your branch
git checkout -b feature/your-feature

# 3. Work and commit often
git add <files>
git commit -m "feat: add GPS field to meeting form"

# 4. Push and open a Pull Request with base = staging
git push origin feature/your-feature
# → open PR on GitHub, assign at least 1 reviewer
# → ⚠️ GitHub defaults the base to `main` — change it to `staging`

# 5. After approval, merge to staging (squash merge recommended)
# → delete the branch, then verify on the staging site

# 6. Promote: open a PR with base = main, compare = staging, and merge it
# → production deploys, and any new migrations apply to the prod database
```

### Commit Message Format

| Prefix | When to use |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `chore:` | Config, deps, tooling |
| `refactor:` | Code change with no behavior change |
| `style:` | UI or CSS only |

**Examples:**
```
feat: add export to Excel on reports page
fix: correct lost opportunity reassignment date
chore: upgrade TanStack Table to v8.21
refactor: extract meeting form into shared component
```

### Pull Request Checklist

Before requesting a review, make sure:

- [ ] The PR's base is **`staging`**, not `main`
- [ ] The branch is up to date with `staging` (`git pull origin staging`)
- [ ] `npm run build` passes with no errors
- [ ] `npm run lint` passes with no warnings
- [ ] The feature works as expected in the browser
- [ ] No `.env.local`, `.env.prod.local`, or other secrets are committed
