// Run with: npm run mobile:status
// Fetches latest commits and merged PRs from the mobile repo's main branch
// and writes the result to MOBILE_STATUS.md in the project root.

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO = 'VinceCarter12/OracleSalesApp-Mobile';
const BASE_URL = `https://api.github.com/repos/${REPO}`;
const HEADERS = { 'User-Agent': 'sales-admin-status-script', Accept: 'application/vnd.github+json' };

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${url}`);
  return res.json();
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

async function main() {
  console.log('Fetching mobile repo status...');

  const [commits, mergedPRs] = await Promise.all([
    fetchJSON(`${BASE_URL}/commits?sha=main&per_page=10`),
    fetchJSON(`${BASE_URL}/pulls?state=closed&base=main&per_page=10`),
  ]);

  const recentMerges = mergedPRs.filter(pr => pr.merged_at).slice(0, 5);

  const now = formatDate(new Date().toISOString());

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
      ? '_No recently merged PRs found._'
      : recentMerges.map((pr, i) => {
          const date = formatDate(pr.merged_at);
          return `${i + 1}. [#${pr.number} ${pr.title}](${pr.html_url}) — merged by **${pr.merged_by?.login ?? 'unknown'}** · ${date}`;
        }).join('\n'),
    ``,
  ];

  const output = lines.join('\n');
  const outPath = resolve(__dirname, '..', 'MOBILE_STATUS.md');
  writeFileSync(outPath, output, 'utf-8');

  console.log(`Done. Written to MOBILE_STATUS.md`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
