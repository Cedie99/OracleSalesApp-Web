#!/usr/bin/env node
// Run a Next.js command against an explicitly chosen Supabase environment.
//
//   node scripts/dev-env.mjs staging -- dev
//   node scripts/dev-env.mjs prod    -- dev
//   node scripts/dev-env.mjs prod    --check      (validate the file, run nothing)
//
// Why this exists: production carries real users and real data. `next dev` has no
// --env-file flag, and Next only auto-loads `.env.local` / `.env.<NODE_ENV>.local`
// — so there is no built-in way to say "this run targets staging". Without that,
// which database you are hitting depends on what someone last pasted into
// `.env.local`, which is invisible until you have already written to it.
//
// So: staging lives in `.env.local` (the safe default that every implicit loader
// — `next build`, `next start`, `next lint` — picks up), production lives in
// `.env.prod.local` and is only ever read by an explicit `prod` run. Values are
// injected through `process.env`, which wins over every `.env*` file, so a prod
// run cannot silently inherit a staging value or the reverse.

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TARGETS = {
  staging: {
    file: '.env.local',
    ref: 'xhxjbzesuzprwdelrdwh',
    label: 'STAGING',
    banner: '\x1b[42m\x1b[30m', // green
    note: 'Fake data — break it freely.',
  },
  prod: {
    file: '.env.prod.local',
    ref: 'itpskcyojtpcpjwolieb',
    label: 'PRODUCTION',
    banner: '\x1b[41m\x1b[97m', // red
    note: 'REAL users, REAL data. Reads only — do not test writes here.',
  },
}

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

function die(msg) {
  console.error(`\n\x1b[31m✗ ${msg}${RESET}\n`)
  process.exit(1)
}

// Minimal `.env` parser: KEY=VALUE, `#` comments, optional surrounding quotes.
// Deliberately not dotenv — we only need to read our own three-line files, and a
// hand-rolled parser keeps the safety checks below dependency-free.
function parseEnvFile(filePath) {
  const out = {}
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// Supabase legacy keys are JWTs carrying the project ref and the role they grant.
// Decoding them catches the dangerous paste error the URL check alone misses:
// right URL, wrong project's key — or an anon slot holding a service_role key.
function jwtClaims(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function refFromUrl(url) {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec(url.trim())
  return match ? match[1] : null
}

function validate(env, target) {
  const missing = REQUIRED.filter((key) => !env[key] || env[key].startsWith('PASTE_'))
  if (missing.length) {
    die(
      `${target.file} is missing a value for:\n    ${missing.join('\n    ')}\n\n` +
        `  Get them from the ${target.label} Supabase project (${target.ref})\n` +
        `  → Project Settings → API Keys.`
    )
  }

  const urlRef = refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL)
  if (!urlRef) {
    die(`NEXT_PUBLIC_SUPABASE_URL in ${target.file} is not a Supabase project URL:\n    ${env.NEXT_PUBLIC_SUPABASE_URL}`)
  }
  if (urlRef !== target.ref) {
    die(
      `${target.file} points at the WRONG project.\n` +
        `  Expected ${target.label} (${target.ref}) but found ${urlRef}.\n` +
        `  Refusing to start — this is exactly the mix-up this script exists to catch.`
    )
  }

  for (const [key, expectedRole] of [
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'service_role'],
  ]) {
    const claims = jwtClaims(env[key])
    // Newer `sb_publishable_…` / `sb_secret_…` keys are opaque, not JWTs. Nothing
    // to verify there, so skip rather than block a legitimate key format.
    if (!claims) continue
    if (claims.ref && claims.ref !== target.ref) {
      die(`${key} in ${target.file} belongs to project '${claims.ref}', not ${target.label} ('${target.ref}').`)
    }
    if (claims.role && claims.role !== expectedRole) {
      die(`${key} in ${target.file} is a '${claims.role}' key, expected '${expectedRole}'. The keys look swapped.`)
    }
  }
}

const argv = process.argv.slice(2)
const targetName = argv[0]
const target = TARGETS[targetName]
if (!target) {
  die(`Unknown target '${targetName ?? ''}'. Use one of: ${Object.keys(TARGETS).join(', ')}`)
}

const checkOnly = argv.includes('--check')
const separator = argv.indexOf('--')
const nextArgs = separator === -1 ? [] : argv.slice(separator + 1)

const envPath = path.join(root, target.file)
if (!existsSync(envPath)) {
  die(
    `${target.file} does not exist.\n` +
      `  Copy .env.example to ${target.file} and fill in the ${target.label} values\n` +
      `  from Supabase project ${target.ref}.`
  )
}

const fileEnv = parseEnvFile(envPath)
validate(fileEnv, target)

const width = 64
const pad = (text) => ` ${text}`.padEnd(width)
console.log('')
console.log(target.banner + pad(`${target.label}  •  ${target.ref}`) + RESET)
console.log(target.banner + pad(target.note) + RESET)
console.log(`${DIM} env file: ${target.file}${RESET}`)
console.log('')

if (checkOnly) {
  console.log(`\x1b[32m✓ ${target.file} is valid.${RESET}\n`)
  process.exit(0)
}

if (nextArgs.length === 0) {
  die('Nothing to run. Pass the Next.js command after `--`, e.g. `-- dev`.')
}

// Injecting via process.env puts these at the top of Next's lookup order, above
// every `.env*` file — so a prod run cannot fall through to a staging value.
const child = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), ...nextArgs],
  { stdio: 'inherit', env: { ...process.env, ...fileEnv }, cwd: root }
)

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
