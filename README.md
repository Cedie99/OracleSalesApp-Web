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

Create a `.env.local` file in the project root and ask the project lead for the values:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

### 4. Start the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server at `http://localhost:3000` |
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

This project follows **GitHub Flow** — a lightweight branch-based workflow suited for a small team with continuous deployment.

### Core Rules

1. **`main` is always deployable.** Never push directly to it.
2. **One branch per task or feature.** Always branch off `main`.
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
# 1. Start from an up-to-date main
git checkout main
git pull origin main

# 2. Create your branch
git checkout -b feature/your-feature

# 3. Work and commit often
git add <files>
git commit -m "feat: add GPS field to meeting form"

# 4. Push and open a Pull Request
git push origin feature/your-feature
# → open PR on GitHub, assign at least 1 reviewer

# 5. After approval, merge to main (squash merge recommended)
# → delete the branch
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

- [ ] The branch is up to date with `main` (`git pull origin main`)
- [ ] `npm run build` passes with no errors
- [ ] `npm run lint` passes with no warnings
- [ ] The feature works as expected in the browser
- [ ] No `.env.local` or secrets are committed
