#!/usr/bin/env node
// Snapshot of the public numbers of the extension. Prints a Markdown row; with --append it also appends it to docs/METRICAS.md.
// Optional: POLAR_OAT=<organization access token> (or a POLAR_OAT= line in Documents/changekeeper-secrets.txt) adds Polar orders/keys.
// No dependencies. Usage: node scripts/metrics.mjs [--append] [--json]
import fs from 'node:fs';
import path from 'node:path';

const EXT = { publisher: 'argalla', name: 'changekeeper', repo: 'TecniartGalicia/changekeeper', polarOrg: '' };
const args = new Set(process.argv.slice(2));
const UA = { 'User-Agent': 'changekeeper-metrics/1.0 (+https://github.com/TecniartGalicia/changekeeper)' };
const nd = 'n/d';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, init = {}) {
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
    if (!r.ok) return { __err: `HTTP ${r.status}` };
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { __err: 'not json' }; }
  } catch (e) { return { __err: e.message }; }
}

async function marketplace() {
  const body = { filters: [{ criteria: [{ filterType: 7, value: `${EXT.publisher}.${EXT.name}` }] }], flags: 914 };
  // The gallery answers from several caches that disagree by hours; installs/downloads only grow, so ask a few times with
  // The gallery answers WITHOUT `statistics` most of the time (measured: ~1 in 6 answers carries them,
  // regardless of api-version or headers), so we retry until one does — and keep the max of each.
  const variants = [{}, { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, { 'Accept-Encoding': 'identity' }];
  let e; const st = {};
  for (let attempt = 0; attempt < 15 && Object.keys(st).length === 0; attempt++) {
    const extra = variants[attempt % variants.length];
    const j = await json('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.1-preview.1', ...extra }, body: JSON.stringify(body) });
    const x = j?.results?.[0]?.extensions?.[0];
    if (!x) {
      await sleep(600);
      continue;
    }
    e = e ?? x;
    for (const s of x.statistics || []) st[s.statisticName] = Math.max(st[s.statisticName] ?? 0, Number(s.value) || 0);
    if (Object.keys(st).length === 0) await sleep(600);
  }
  if (!e) return { installs: nd, downloads: nd, version: nd, rating: nd, ratings: nd, reviews: nd, reviewList: [] };
  const rv = await json(`https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${EXT.publisher}/extensions/${EXT.name}/reviews?count=100&filterOptions=1&api-version=7.1-preview.1`, { headers: { Accept: 'application/json;api-version=7.1-preview.1' } });
  // The gallery often answers without `statistics` at all; reporting 0 in that case is a lie that would
  // also overwrite a good measurement of the same day (see --append below), so it is n/d instead.
  const noStats = Object.keys(st).length === 0;
  return { installs: noStats ? nd : st.install ?? 0, downloads: noStats ? nd : st.downloadCount ?? 0, version: e.versions?.[0]?.version ?? nd, rating: st.averagerating ? Number(st.averagerating).toFixed(1) : '-', ratings: noStats ? nd : st.ratingcount ?? 0, reviews: rv?.totalReviewCount ?? nd, reviewList: rv?.reviews ?? [] };
}

async function openvsx() {
  const j = await json(`https://open-vsx.org/api/${EXT.publisher}/${EXT.name}`);
  return { downloads: j.downloadCount ?? nd, version: j.version ?? nd, reviews: j.reviewCount ?? 0, rating: j.averageRating ?? '-', verified: j.verified };
}

async function github() {
  const j = await json(`https://api.github.com/repos/${EXT.repo}`);
  const issues = await json(`https://api.github.com/repos/${EXT.repo}/issues?state=open&per_page=50`);
  const rel = await json(`https://api.github.com/repos/${EXT.repo}/releases`);
  const dl = Array.isArray(rel) ? rel.flatMap((r) => r.assets || []).reduce((a, x) => a + (x.download_count || 0), 0) : nd;
  return { stars: j.stargazers_count ?? nd, forks: j.forks_count ?? nd, watchers: j.subscribers_count ?? nd, openIssues: Array.isArray(issues) ? issues.filter((i) => !i.pull_request).length : nd, openPRs: Array.isArray(issues) ? issues.filter((i) => i.pull_request).length : nd, releaseDownloads: dl, issueTitles: Array.isArray(issues) ? issues.map((i) => `#${i.number} ${i.title}`) : [] };
}

async function hn() {
  const j = await json('https://hn.algolia.com/api/v1/search?query=%22changekeeper%22%20vscode&tags=(story,comment)');
  return { hits: j?.nbHits ?? nd, titles: (j?.hits || []).slice(0, 5).map((h) => h.title || h.story_title || '').filter(Boolean) };
}

async function reddit() {
  // Anonymous search is often blocked (HTML instead of JSON); report n/d then and search by hand.
  const j = await json('https://api.reddit.com/search?q=%22changekeeper%22%20vscode&sort=new&limit=10');
  if (j?.__err || !j?.data) return { hits: nd, titles: [] };
  return { hits: j.data.children.length, titles: j.data.children.map((c) => `r/${c.data.subreddit}: ${c.data.title}`) };
}

function polarToken() {
  if (process.env.POLAR_OAT) return process.env.POLAR_OAT;
  try {
    const f = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Documents', 'changekeeper-secrets.txt');
    const l = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((x) => x.startsWith('POLAR_OAT='));
    return l ? l.slice(10).trim() : '';
  } catch { return ''; }
}

async function polar() {
  const tok = polarToken();
  if (!tok) return { orders: nd, revenue: nd, keys: nd, note: 'sin POLAR_OAT (mirar panel)' };
  const H = { Authorization: `Bearer ${tok}` };
  // an empty organization_id is a malformed filter (422): the token is already scoped to the org, so omit it
  const org = EXT.polarOrg ? `organization_id=${EXT.polarOrg}&` : '';
  const o = await json(`https://api.polar.sh/v1/orders/?${org}limit=100`, { headers: H });
  const k = await json(`https://api.polar.sh/v1/license-keys/?${org}limit=100`, { headers: H });
  if (o?.__err) return { orders: nd, revenue: nd, keys: nd, note: `Polar API: ${o.__err}` };
  const items = o.items || [];
  const paid = items.filter((x) => (x.net_amount ?? x.amount ?? 0) > 0);
  const revenue = paid.reduce((a, x) => a + (x.net_amount ?? x.amount ?? 0), 0) / 100;
  const cur = paid[0]?.currency ? String(paid[0].currency).toUpperCase() : 'EUR';
  const keys = k?.__err ? nd : k?.pagination?.total_count ?? (k?.items || []).length;
  return { orders: items.length, paidOrders: paid.length, revenue: `${revenue.toFixed(2)} ${cur === 'EUR' ? '€' : cur}`, keys, granted: k?.__err ? undefined : (k?.items || []).filter((x) => x.status === 'granted').length, note: k?.__err ? `claves: ${k.__err}` : undefined };
}

const [mk, ov, gh, hnr, rd, po] = await Promise.all([marketplace(), openvsx(), github(), hn(), reddit(), polar()]);
const today = new Date().toISOString().slice(0, 10);
const row = `| ${today} | ${mk.installs} | ${mk.downloads} | ${mk.rating}/${mk.ratings} (${mk.reviews} reseñas) | ${ov.downloads} | ${gh.stars} | ${gh.openIssues}/${gh.openPRs} | ${gh.releaseDownloads} | ${po.orders}${po.paidOrders !== undefined ? ` (${po.paidOrders} de pago, ${po.revenue})` : ''} | ${po.keys}${po.granted !== undefined ? ` (${po.granted} activas)` : ''} | ${hnr.hits} | ${rd.hits} |`;
const header = `| Fecha | MP instalaciones | MP descargas | MP valoración (n) | Open VSX descargas | GH ★ | Issues/PR abiertos | .vsix release | Pedidos Polar | Claves | HN menciones | Reddit menciones |\n|---|---:|---:|---|---:|---:|---|---:|---|---|---:|---:|`;

if (args.has('--json')) {
  console.log(JSON.stringify({ date: today, marketplace: mk, openvsx: ov, github: gh, hn: hnr, reddit: rd, polar: po }, null, 2));
} else {
  console.log(header + '\n' + row);
  if (mk.version !== ov.version) console.log(`\n⚠ versiones distintas: Marketplace ${mk.version} vs Open VSX ${ov.version}`);
  if (gh.issueTitles.length) console.log('\nIssues/PR abiertos:\n- ' + gh.issueTitles.join('\n- '));
  if (mk.reviewList.length) console.log('\nReseñas Marketplace:\n- ' + mk.reviewList.map((r) => `${r.rating}★ ${r.userDisplayName}: ${(r.text || '').slice(0, 120)}`).join('\n- '));
  if (hnr.titles.length) console.log('\nHN:\n- ' + hnr.titles.join('\n- '));
  if (rd.titles.length) console.log('\nReddit:\n- ' + rd.titles.join('\n- '));
  if (po.note) console.log(`\nPolar: ${po.note}`);
}

/** Cell-by-cell merge of two rows of the same day: a number never goes down, n/d never wins over a value. */
function mergeRows(a, b) {
  const A = a.split('|'), B = b.split('|');
  if (A.length !== B.length) return b;
  return B.map((cell, i) => {
    const x = A[i].trim(), y = cell.trim();
    if (!y || y === nd) return A[i];
    if (!x || x === nd) return cell;
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) return nx > ny ? A[i] : cell;
    return cell;
  }).join('|');
}

if (args.has('--append')) {
  const file = path.resolve('docs', 'METRICAS.md');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!text.includes('| Fecha |')) text = `# Métricas — ChangeKeeper\n\nGeneradas con \`node scripts/metrics.mjs --append\` (APIs públicas; Polar solo con POLAR_OAT). "n/d" = no disponible.\n\n${header}\n`;
  const prev = text.split(/\r?\n/).find((l) => l.startsWith(`| ${today} |`));
  // never let a bad read (n/d, or the gallery's frequent empty answer) lower a counter already recorded today
  const merged = prev ? mergeRows(prev, row) : row;
  if (!prev) fs.writeFileSync(file, text.replace(/\n*$/, '\n') + merged + '\n', 'utf8');
  else fs.writeFileSync(file, text.replace(prev, merged), 'utf8');
  console.log(`\n→ ${path.relative(process.cwd(), file)} actualizado`);
}
