// Run with: npm run mobile:status
// Dynamically fetches all source files from the mobile repo's main branch
// and writes commits, merged PRs, and full source to MOBILE_STATUS.md.

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO = 'VinceCarter12/OracleSalesApp-Mobile';
const BASE_URL = `https://api.github.com/repos/${REPO}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const HEADERS = { 'User-Agent': 'sales-admin-status-script', Accept: 'application/vnd.github+json' };

// Directories to include — all source files under these paths will be fetched
const INCLUDE_DIRS = ['app', 'lib', 'types'];

// File extensions to fetch
const INCLUDE_EXTENSIONS = ['.ts', '.tsx', '.js'];

// Specific root-level files to always fetch
const EXTRA_FILES = ['package.json', 'app.json', '.env.local.example'];

// Paths to skip even if they match the above rules
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /package-lock\.json/,
  /\.env/,
];

function shouldInclude(path) {
  if (EXCLUDE_PATTERNS.some(pattern => pattern.test(path))) return false;
  const inIncludedDir = INCLUDE_DIRS.some(dir => path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`));
  const hasValidExt = INCLUDE_EXTENSIONS.some(ext => path.endsWith(ext));
  return inIncludedDir && hasValidExt;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${url}`);
  return res.json();
}

async function fetchRaw(path) {
  const res = await fetch(`${RAW_BASE}/${path}`);
  if (!res.ok) return `// Could not fetch: ${res.status}`;
  return res.text();
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

function labelFromPath(path) {
  return path.replace(/\\/g, '/');
}

async function main() {
  console.log('Fetching mobile repo status...');

  const [commits, mergedPRs, tree] = await Promise.all([
    fetchJSON(`${BASE_URL}/commits?sha=main&per_page=10`),
    fetchJSON(`${BASE_URL}/pulls?state=closed&base=main&per_page=10`),
    fetchJSON(`${BASE_URL}/git/trees/main?recursive=1`),
  ]);

  const sourceFiles = tree.tree.filter(
    entry => entry.type === 'blob' && shouldInclude(entry.path)
  );

  const extraFiles = EXTRA_FILES.filter(
    f => tree.tree.some(entry => entry.path === f)
  );

  const allFiles = [
    ...extraFiles.map(path => ({ path, group: 'root' })),
    ...sourceFiles.map(({ path }) => ({ path, group: 'source' })),
  ];

  console.log(`Found ${allFiles.length} files (${sourceFiles.length} source + ${extraFiles.length} config). Fetching content...`);

  const fileContents = await Promise.all(
    allFiles.map(async ({ path, group }) => {
      const content = await fetchRaw(path);
      return { path, content, group };
    })
  );

  const recentMerges = mergedPRs.filter(pr => pr.merged_at).slice(0, 5);
  const now = formatDate(new Date().toISOString());

  // Group source files by directory for organized output
  const grouped = {};
  for (const file of fileContents.filter(f => f.group === 'source')) {
    const dir = file.path.split('/').slice(0, -1).join('/') || '.';
    if (!grouped[dir]) grouped[dir] = [];
    grouped[dir].push(file);
  }

  const configFiles = fileContents.filter(f => f.group === 'root');

  const lines = [
    `# Mobile App Status`,
    ``,
    `> **Repo:** [${REPO}](https://github.com/${REPO})`,
    `> **Branch:** \`main\``,
    `> **Last synced:** ${now}`,
    `> Run \`npm run mobile:status\` to refresh.`,
    ``,
    `---`,
    ``,
    `## Latest Commits on \`main\``,
    ``,
    ...commits.map((c, i) => {
      const msg = c.commit.message.split('\n')[0];
      const author = c.commit.author.name;
      const date = formatDate(c.commit.author.date);
      const sha = c.sha.slice(0, 7);
      const url = c.html_url;
      return `${i + 1}. [\`${sha}\`](${url}) **${msg}** — ${author} · ${date}`;
    }),
    ``,
    `---`,
    ``,
    `## Recently Merged Pull Requests`,
    ``,
    recentMerges.length === 0
      ? `_No recently merged PRs found._`
      : recentMerges.map((pr, i) => {
          const date = formatDate(pr.merged_at);
          return `${i + 1}. [#${pr.number} ${pr.title}](${pr.html_url}) — merged by **${pr.merged_by?.login ?? 'unknown'}** · ${date}`;
        }).join('\n'),
    ``,
    `---`,
    ``,
    `## Config & Environment Files`,
    ``,
    ...configFiles.flatMap(({ path, content }) => {
      const ext = path.split('.').pop();
      const lang = ext === 'json' ? 'json' : ext === 'ts' ? 'typescript' : 'text';
      return [
        `#### \`${path}\``,
        ``,
        `\`\`\`${lang}`,
        content.trimEnd(),
        `\`\`\``,
        ``,
      ];
    }),
    `---`,
    ``,
    `## Source Files (${fileContents.filter(f => f.group === 'source').length} files)`,
    ``,
    `> Fetched live from \`main\`. Any new file added to the mobile repo`,
    `> will automatically appear here on the next run.`,
    ``,
    ...Object.entries(grouped).sort().flatMap(([dir, files]) => [
      `### \`${dir}/\``,
      ``,
      ...files.flatMap(({ path, content }) => {
        const ext = path.split('.').pop();
        return [
          `#### \`${labelFromPath(path)}\``,
          ``,
          `\`\`\`${ext === 'tsx' || ext === 'ts' ? 'typescript' : ext}`,
          content.trimEnd(),
          `\`\`\``,
          ``,
        ];
      }),
    ]),
  ];

  const output = lines.join('\n');
  const outPath = resolve(__dirname, '..', 'MOBILE_STATUS.md');
  writeFileSync(outPath, output, 'utf-8');

  console.log(`Done. Written to MOBILE_STATUS.md (${fileContents.length} files fetched — ${extraFiles.length} config, ${sourceFiles.length} source)`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
