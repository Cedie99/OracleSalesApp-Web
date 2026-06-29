# Sales Admin

A Next.js 16 admin dashboard for managing sales teams, clients, meetings, and approvals. Built with Supabase for authentication and data, shadcn/ui for components, and Recharts for analytics.

## Features

- **Dashboard** — monthly meeting trends, success rates by client type, and outcome breakdowns
- **Clients** — manage existing clients, new clients, and prospects with assignment tracking
- **Meetings** — log face-to-face and online meetings with GPS, photo, agenda, and outcome fields
- **Approvals** — review and approve/reject client edit requests submitted by agents
- **Lost Opportunities** — track and reassign lost clients (reassignable after 14 days)
- **Clock Records** — agent clock-in/out records for office and field events
- **Reports** — exportable sales reports

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS v4, shadcn/ui |
| Database & Auth | Supabase (PostgreSQL + Auth) |
| Tables | TanStack Table v8 |
| Charts | Recharts v3 |
| Notifications | Sonner |
| Date Handling | date-fns v4 |
| Excel Export | xlsx |

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [npm](https://www.npmjs.com/) (included with Node.js)
- A [Supabase](https://supabase.com/) account (free tier works)

---

## Getting Started

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd sales-admin
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Supabase

#### Create a Project

1. Go to [supabase.com](https://supabase.com/) and sign in
2. Click **New project** and fill in the project name and database password
3. Wait for the project to finish provisioning (~1–2 minutes)

#### Run the Database Migration

1. In your Supabase dashboard, open **SQL Editor**
2. Click **New query**
3. Copy the contents of `supabase/migrations/001_initial.sql` and paste it into the editor
4. Click **Run**

This creates the following tables with Row Level Security enabled:
- `teams` — sales team groupings
- `profiles` — user profiles linked to Supabase Auth (roles: `admin`, `sales_manager`, `sales_specialist`)
- `clients` — client records with status tracking
- `client_edit_requests` — approval workflow for client edits
- `meetings` — meeting logs with location and outcome data
- `clock_records` — agent attendance records

#### Seed the Admin Account

1. In **SQL Editor**, open a new query
2. Copy the contents of `supabase/seed_admin.sql` and paste it
3. Optionally change the `v_email` and `v_pass` values at the top before running
4. Click **Run**

Default credentials (change before production use):
- **Email:** `admin@salesadmin.local`
- **Password:** `Admin@2025!`

#### Get Your API Keys

1. In your Supabase dashboard, go to **Project Settings → API**
2. Copy the **Project URL** and the **anon/public** key

### 4. Configure Environment Variables

Create a `.env.local` file in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

Replace the values with your actual Supabase project URL and anon key from the previous step.

### 5. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. You will be redirected to the login page. Sign in with the admin credentials you seeded above.

---

## Project Structure

```
sales-admin/
├── app/
│   ├── (admin)/            # Protected admin layout
│   │   ├── dashboard/
│   │   ├── clients/
│   │   ├── meetings/
│   │   ├── approvals/
│   │   ├── lost-opportunities/
│   │   ├── clock-records/
│   │   └── reports/
│   ├── login/              # Public login page
│   ├── layout.tsx
│   └── globals.css
├── components/             # Shared UI components
├── lib/
│   ├── supabase/           # Supabase client and server helpers
│   ├── mock/               # Mock data for development
│   └── utils.ts
├── supabase/
│   ├── migrations/
│   │   └── 001_initial.sql # Full database schema
│   └── seed_admin.sql      # Initial admin account seed
└── types/                  # Shared TypeScript types
```

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server at `http://localhost:3000` |
| `npm run build` | Build for production |
| `npm start` | Run the production build |
| `npm run lint` | Run ESLint |

---

## User Roles

| Role | Description |
|---|---|
| `admin` | Full access to all data, approvals, and reports |
| `sales_manager` | Manages their team's clients and meetings |
| `sales_specialist` | Manages their own clients and meetings; edits require approval |

New users are created through Supabase Auth and assigned a role via the `profiles` table. Only an `admin` can assign roles.

---

## Deployment

### Vercel (Recommended)

1. Push your code to GitHub
2. Import the repository at [vercel.com/new](https://vercel.com/new)
3. Add the environment variables (`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`) in the Vercel project settings
4. Deploy

### Other Platforms

Build the project and serve the output:

```bash
npm run build
npm start
```

Ensure the two `NEXT_PUBLIC_SUPABASE_*` environment variables are set in your hosting environment.

---

## Security Notes

- Change the default admin credentials in `supabase/seed_admin.sql` before seeding a production database
- Never commit `.env.local` to version control — it is already listed in `.gitignore`
- Row Level Security (RLS) is enabled on all tables; policies enforce role-based access at the database level

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

Use a short prefix so the git history stays scannable:

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
