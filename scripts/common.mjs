import * as cheerio from 'cheerio';

// ---- utils ----
export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export const isArabic = (t = '') => /[\u0600-\u06FF]/.test(t);

export function summarize(text = '', maxLen = 220) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen - 1) + '…';
}

export function stripHtml(html = '') {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

export async function fetchWithRetry(url, opts = {}, retries = 2, timeoutMs = 15000) {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (i === retries) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

export async function discoverFeedFromHTML(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = $(
    'link[rel="alternate"][type*="rss"], ' +
      'link[rel="alternate"][type*="atom"], ' +
      'a[href*="rss"], a[href*="feed"], a[href$=".xml"]'
  );
  const urls = new Set();
  links.each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const u = new URL(href, baseUrl).toString();
      if (/xml|rss|feed/i.test(u)) urls.add(u);
    } catch {}
  });
  return Array.from(urls);
}

export async function extractOpenGraph(html) {
  const $ = cheerio.load(html);
  const ogImage = $('meta[property="og:image"], meta[name="og:image"]').attr('content');
  const ogDesc =
    $('meta[property="og:description"], meta[name="description"]').attr('content') || '';
  return { ogImage: ogImage || null, ogDesc: ogDesc || '' };
}

export function classifyCategory(text, fallback = []) {
  const t = (text || '').toLowerCase();
  if (/(sport|match|league|cup|fifa|uefa|nba|premier|رياضي|رياضة|مباراة|بطولة|دوري)/i.test(t))
    return 'sports';
  if (/(tech|تكنولوجيا|تقنية|gadgets|هواتف|ذكاء اصطناعي|ai|chip|semiconductor|apps|software)/i.test(t))
    return 'technology';
  if (/(health|صحة|دواء|طب|wellness|fitness)/i.test(t)) return 'health';
  if (/(travel|سفر|سياحة|مطاعم|مطعم|وصفات|طبخ|lifestyle|منوعات|varieties)/i.test(t))
    return 'lifestyle';
  if (/(gold|ذهب|bullion|سعر الذهب|أسعار الذهب|currency|exchange|سعر الصرف|أسعار الصرف|oil|نفط|بورصة)/i.test(t))
    return 'markets';
  if (/(طقس|weather|forecast|أرصاد|أحوال جوية)/i.test(t)) return 'weather';
  if (/(science|علوم|space|فضاء|research|بحث|علمي)/i.test(t)) return 'science';
  if (/(entertainment|فن|نجوم|سينما|مسلسلات|موسيقى)/i.test(t)) return 'entertainment';
  if (fallback.length) return fallback[0];
  return 'general';
}

export function compileBlacklist(black) {
  function esc(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const parts = [
    ...(black?.ar || []),
    ...(black?.en || []),
    ...(black?.adult || []),
    ...(black?.violence || []),
  ].map(esc);
  const re = parts.length ? new RegExp(`\\b(${parts.join('|')})\\b`, 'i') : null;
  return (text) => (re ? re.test((text || '').toLowerCase()) : false);
}
