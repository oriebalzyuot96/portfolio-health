import { request, pool } from './crawl.js';

export const DEFAULTS = {
  maxPages: 60, concurrency: 4, timeoutMs: 10000,
  requiredFiles: ['/Orieb-Alzyuot-CV.pdf'], allow: [], pageWeightBytes: 1.5 * 1024 * 1024,
};

const allowed = (url, allow = []) => allow.some((a) => url === a || url.startsWith(a));
const issue = (rule, severity, url, message) => ({ rule, severity, url, message });
const isHtml = (p) => p.status === 200 && /html/i.test(p.contentType || 'text/html');

/** Pure checks over a crawl result (no network). */
export function checkPages(crawlResult, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const out = [];
  const titles = new Map();
  for (const p of crawlResult.pages) {
    if (allowed(p.url, cfg.allow)) continue;
    if (p.status !== 200) out.push(issue('page-status', 'error', p.url, p.status === 0 ? `Unreachable (${p.error || 'error'})` : `Status ${p.status}`));
    if (p.bytes > cfg.pageWeightBytes) out.push(issue('page-weight', 'warn', p.url, `Page is ${(p.bytes / 1048576).toFixed(2)} MB (limit ${(cfg.pageWeightBytes / 1048576).toFixed(1)} MB)`));
    if (!isHtml(p)) continue;
    if (!p.title) out.push(issue('missing-title', 'error', p.url, 'Missing <title>'));
    else titles.set(p.title, [...(titles.get(p.title) || []), p.url]);
    if (!p.description) out.push(issue('missing-description', 'warn', p.url, 'Missing meta description'));
    if (!p.lang) out.push(issue('missing-lang', 'error', p.url, 'Missing lang attribute on <html>'));
    if (p.lang && /^ar(-|$)/i.test(p.lang) && (p.dir || '').toLowerCase() !== 'rtl') out.push(issue('arabic-page-dir', 'error', p.url, `lang=${p.lang} but dir is ${p.dir ? `"${p.dir}"` : 'missing'} (expected rtl)`));
    if (!p.canonical) out.push(issue('missing-canonical', 'warn', p.url, 'Missing canonical link'));
    for (const img of p.images) if (img.alt === null) out.push(issue('img-alt-missing', 'warn', p.url, `Image without alt: ${img.src}`));
    for (const l of p.links) {
      let u; try { u = new URL(l); } catch { continue; }
      if (u.origin !== crawlResult.baseUrl || allowed(l, cfg.allow)) continue;
      u.hash = '';
      const st = crawlResult.linkStatus?.[u.href];
      if (st === undefined) continue;
      if (st === 0 || st >= 400) out.push(issue('broken-internal-link', 'error', p.url, `Link to ${l} ${st === 0 ? 'is unreachable' : `returns ${st}`}`));
    }
  }
  for (const [title, urls] of titles) {
    if (urls.length > 1) for (const u of urls) out.push(issue('duplicate-title', 'warn', u, `Title "${title}" also used by ${urls.filter((x) => x !== u).join(', ')}`));
  }
  return out;
}

async function defaultProbe(url, timeoutMs) {
  const h = await request(url, { method: 'HEAD', timeoutMs });
  if (h.status > 0 && h.status < 400) return h.status;
  return (await request(url, { timeoutMs, body: false })).status;
}

/** Network check: external links (HEAD, then GET fallback). Always warn-level. */
export async function checkExternalLinks(crawlResult, config = {}, probe = defaultProbe) {
  const cfg = { ...DEFAULTS, ...config };
  const by = new Map();
  for (const p of crawlResult.pages) for (const l of p.links) {
    let u; try { u = new URL(l); } catch { continue; }
    if (u.origin === crawlResult.baseUrl || allowed(l, cfg.allow)) continue;
    u.hash = '';
    by.set(u.href, [...(by.get(u.href) || []), p.url]);
  }
  const urls = [...by.keys()];
  const res = await pool(urls, cfg.concurrency, (u) => probe(u, cfg.timeoutMs));
  const out = [];
  urls.forEach((u, i) => {
    const st = res[i];
    if (st >= 200 && st < 400) return;
    const msg = st === 403 || st === 429 ? `${u} returned ${st}: could not verify` : st === 0 ? `${u} is unreachable` : `${u} returns ${st}`;
    for (const page of new Set(by.get(u))) out.push(issue('broken-external-link', 'warn', page, msg));
  });
  return out;
}

/** Network check: required files must be 200 with the expected content type (PDF for .pdf). */
export async function checkRequiredFiles(crawlResult, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const out = [];
  for (const f of cfg.requiredFiles) {
    const url = new URL(f, crawlResult.baseUrl).href;
    const r = await request(url, { timeoutMs: cfg.timeoutMs, body: false });
    const want = f.toLowerCase().endsWith('.pdf') ? 'application/pdf' : null;
    if (r.status !== 200) out.push(issue('required-file', 'error', url, r.status === 0 ? `Unreachable (${r.error})` : `Required file returned ${r.status}`));
    else if (want && !r.contentType.toLowerCase().includes(want)) out.push(issue('required-file', 'error', url, `Content-Type is "${r.contentType}", expected ${want}`));
  }
  return out;
}

export async function runChecks(crawlResult, config = {}) {
  return [...checkPages(crawlResult, config), ...await checkExternalLinks(crawlResult, config), ...await checkRequiredFiles(crawlResult, config)];
}
