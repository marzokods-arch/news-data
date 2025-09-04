import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import {
  sleep, isArabic, summarize, stripHtml, normalizeUrl,
  fetchWithRetry, discoverFeedFromHTML, extractOpenGraph,
  classifyCategory, compileBlacklist
} from './common.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DOCS = path.join(ROOT, 'docs');
const API = path.join(DOCS, 'api');

const COMMON_HEADERS = {
  'user-agent': 'Mozilla/5.0 (LightNewsDB/2.0; +https://github.com/your/repo)',
  'accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7'
};

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded','contentEncoded'],
      ['media:content','mediaContent', { keepArray: true }],
      ['enclosure','enclosure']
    ]
  }
});

async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
function hash(s) { return createHash('sha1').update(s).digest('hex').slice(0, 16); }

// Load configs
const black = JSON.parse(await fs.readFile(path.join(DATA,'blacklists.json'),'utf-8'));
const allowCats = JSON.parse(await fs.readFile(path.join(DATA,'allowlist_categories.json'),'utf-8'));
const excludePaths = JSON.parse(await fs.readFile(path.join(DATA,'exclude_paths.json'),'utf-8'));

// Seeds (homepages for autodiscovery)
let seeds = [];
try {
  seeds = JSON.parse(await fs.readFile(path.join(DATA,'seeds','homepages.json'),'utf-8'));
} catch { seeds = []; }

// Persistent state for ETag/Last-Modified
const STATE_DIR = path.join(DATA, 'state');
await ensureDir(STATE_DIR);
const statePath = path.join(STATE_DIR, 'feeds_state.json');
let feedState = {};
try { feedState = JSON.parse(await fs.readFile(statePath,'utf-8')); } catch {}

const isBad = compileBlacklist(black);

// Discovery from seeds + OPML (.opml/.xml in data/opml)
async function discoverFeeds() {
  const registry = new Map();

  // 1) From seeds
  for (const s of seeds) {
    let feedUrl = null;
    try {
      const res = await fetchWithRetry(s.homepage, { headers: { ...COMMON_HEADERS } }, 1, 12000);
      const html = await res.text();
      const urls = await discoverFeedFromHTML(html, s.homepage);
      feedUrl = urls[0] || null;
    } catch {}
    if (feedUrl) {
      const bad = excludePaths.some(x => feedUrl.toLowerCase().includes(x));
      if (!bad) registry.set(feedUrl, { ...s, feedUrl });
    }
  }

  // 2) From OPML
  const OPML_DIR = path.join(DATA, 'opml');
  await ensureDir(OPML_DIR);
  try {
    const files = await fs.readdir(OPML_DIR);
    for (const f of files.filter(x => x.endsWith('.opml') || x.endsWith('.xml'))) {
      const xml = await fs.readFile(path.join(OPML_DIR, f), 'utf-8');
      const $ = cheerio.load(xml, { xmlMode: true });
      $('outline[type="rss"]').each((_, el) => {
        const feedUrl = $(el).attr('xmlUrl') || $(el).attr('url');
        const title = $(el).attr('title') || $(el).attr('text') || 'OPML Source';
        if (!feedUrl) return;
        if (excludePaths.some(x => feedUrl.toLowerCase().includes(x))) return;
        const lang = /[\u0600-\u06FF]/.test(title) ? 'ar' : 'en';
        if (!registry.has(feedUrl)) {
          registry.set(feedUrl, {
            name: title,
            homepage: feedUrl,
            feedUrl,
            lang,
            region: 'global',
            categories: ['general']
          });
        }
      });
    }
  } catch {}

  return Array.from(registry.values());
}

// Ingest one feed with conditional GET
async function ingestFeed(src) {
  const hp = src.homepage;
  const u = src.feedUrl;
  if (!u) return { src, taken: 0, error: 'no_feed_url' };

  const st = feedState[u] || {};
  const headers = { ...COMMON_HEADERS, referer: hp };
  if (st.etag) headers['if-none-match'] = st.etag;
  if (st.lastModified) headers['if-modified-since'] = st.lastModified;

  try {
    const res = await fetchWithRetry(u, { headers }, 1, 15000);
    if (res.status === 304) return { src, taken: 0, notModified: true };

    const etag = res.headers.get('etag');
    const lastMod = res.headers.get('last-modified');
    const xml = await res.text();
    const feed = await parser.parseString(xml);

    const out = [];
    for (const entry of (feed.items || [])) {
      const title = (entry.title || '').trim();
      const link = normalizeUrl(entry.link || '');
      if (!title || !link) continue;
      if (excludePaths.some(x => link.toLowerCase().includes(x))) continue;

      const summary = summarize(entry.contentSnippet || entry.content || entry['content:encoded'] || '', 300);
      const hay = `${src.name} ${title} ${summary}`.toLowerCase();
      if (isBad(hay)) continue; // politics/adult/violence

      const lang = src.lang || (isArabic(`${title} ${summary}`) ? 'ar' : 'en');
      const cat = classifyCategory(
        `${title} ${summary} ${(feed.title || '')} ${(entry.categories || []).join(' ')}`,
        src.categories
      );
      if (!allowCats.includes(cat)) continue;

      let image = null;
      if (entry.enclosure?.url && /^image\//i.test(entry.enclosure?.type || 'image/')) image = entry.enclosure.url;
      const media = Array.isArray(entry.mediaContent) ? entry.mediaContent.find(m => m?.$?.url || m?.url) : null;
      if (!image && media) image = media.$?.url || media.url;

      let body = null;
      if (entry['content:encoded']) body = summarize(stripHtml(entry['content:encoded']), 1200);

      const pub = entry.isoDate || entry.pubDate || null;

      out.push({
        id: hash(`${link}|${title}`),
        title,
        link,
        summary,
        body,
        image,
        pubDate: pub ? new Date(pub).toISOString() : null,
        source: { name: src.name, homepage: src.homepage },
        lang,
        category: cat,
        region: src.region || 'global'
      });
    }

    feedState[u] = { etag, lastModified: lastMod, lastRun: Date.now() };
    return { src, taken: out.length, items: out };
  } catch (e) {
    return { src, taken: 0, error: String(e) };
  }
}

function shardIndex(u, shards) {
  let x = 0;
  for (let i = 0; i < u.length; i++) x = (x * 31 + u.charCodeAt(i)) >>> 0;
  return x % shards;
}

(async function main() {
  await ensureDir(DOCS);
  await ensureDir(API);
  await ensureDir(path.join(API, 'categories'));
  await ensureDir(path.join(API, 'lang'));
  await ensureDir(path.join(API, 'regions'));
  await ensureDir(path.join(API, 'days'));

  const discovered = await discoverFeeds();

  // Optional explicit feeds.json merge (if present)
  let explicitFeeds = [];
  try {
    explicitFeeds = JSON.parse(await fs.readFile(path.join(DATA, 'feeds.json'), 'utf-8'));
  } catch {}

  const all = [...discovered, ...explicitFeeds]
    .filter((v, i, arr) => arr.findIndex(x => x.feedUrl === v.feedUrl) === i);

  // Sharding plan: sports every run; others by shard
  const SHARDS = 5;
  const now = new Date();
  const shard = now.getMinutes() % SHARDS;

  const sports = all.filter(s => (s.categories || []).includes('sports'));
  const nonSports = all.filter(s => !(s.categories || []).includes('sports'));
  const bucket = nonSports.filter(s => shardIndex(s.feedUrl || s.homepage || '', SHARDS) === shard);

  const workList = [...sports, ...bucket];

  // Concurrency
  const CONCURRENCY = 20;
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < workList.length) {
      const i = idx++;
      const r = await ingestFeed(workList[i]);
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Collect items
  let items = results.flatMap(r => r.items || []);

  // Sort & cap
  items.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  const MAX_LATEST = 4000;
  items = items.slice(0, MAX_LATEST);

  // Partitions
  const byCat = {};
  const byLang = {};
  const byRegion = {};
  for (const it of items) {
    (byCat[it.category] ||= []).push(it);
    (byLang[it.lang] ||= []).push(it);
    (byRegion[it.region] ||= []).push(it);
  }

  const meta = {
    generated_at: new Date().toISOString(),
    total: items.length,
    processed_feeds: workList.length,
    discovered_feeds: discovered.length,
    sports_processed_every_run: true,
    shard_of: SHARDS,
    shard_index: shard,
    results: results.map(r => ({
      name: r.src?.name,
      url: r.src?.feedUrl,
      homepage: r.src?.homepage,
      lang: r.src?.lang,
      region: r.src?.region,
      cats: r.src?.categories,
      taken: r.taken || 0,
      error: r.error || null,
      notModified: !!r.notModified
    }))
  };

  await fs.writeFile(path.join(API, 'latest.json'), JSON.stringify({ meta, items }, null, 2));
  for (const [k, v] of Object.entries(byCat)) {
    await fs.writeFile(path.join(API, 'categories', `${k}.json`), JSON.stringify(v, null, 2));
  }
  for (const [k, v] of Object.entries(byLang)) {
    await fs.writeFile(path.join(API, 'lang', `${k}.json`), JSON.stringify(v, null, 2));
  }
  for (const [k, v] of Object.entries(byRegion)) {
    await fs.writeFile(path.join(API, 'regions', `${k}.json`), JSON.stringify(v, null, 2));
  }

  // Day snapshot
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await fs.writeFile(path.join(API, 'days', `${dayKey}.json`), JSON.stringify(items, null, 2));

  // Save state
  await fs.writeFile(statePath, JSON.stringify(feedState, null, 2));

  // Index
  await fs.writeFile(
    path.join(API, 'index.json'),
    JSON.stringify({
      latest: '/api/latest.json',
      categories: Object.keys(byCat).map(c => `/api/categories/${c}.json`),
      lang: Object.keys(byLang).map(l => `/api/lang/${l}.json`),
      regions: Object.keys(byRegion).map(r => `/api/regions/${r}.json`),
      days: [`/api/days/${dayKey}.json`]
    }, null, 2)
  );

  console.log(`Done. Items: ${items.length}; Feeds processed: ${workList.length}/${all.length} (sports + shard ${shard}/${SHARDS}).`);
})().catch(e => { console.error(e); process.exit(1); });
