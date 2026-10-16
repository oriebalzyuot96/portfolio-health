// Crawler: static HTML only. Parsing uses simple regular expressions (documented below).

const ATTR = (name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/** Read one attribute from a tag's attribute string. Returns null if absent. */
export function attr(tag, name) {
  const m = ATTR(name).exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/**
 * Parse HTML with regexes:
 *  - title:       first <title>...</title>
 *  - description: <meta name="description" content="...">
 *  - lang / dir:  attributes of the <html ...> tag
 *  - canonical:   <link rel="canonical" href="...">
 *  - links:       href of every <a ...> (resolved to absolute URLs; mailto:/tel:/javascript:/#-only skipped)
 *  - images:      every <img ...> as {src, alt}; alt is null when the attribute is missing
 * HTML comments are stripped first. JavaScript-rendered content is not seen.
 */
export function parseHtml(html, pageUrl) {
  const src = html.replace(/<!--[\s\S]*?-->/g, '');
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = t ? decode(t[1].replace(/\s+/g, ' ')) : null;
  let description = null, canonical = null;
  for (const m of src.matchAll(/<meta\b([^>]*)>/gi)) {
    if ((attr(m[1], 'name') || '').toLowerCase() === 'description') { description = attr(m[1], 'content'); break; }
  }
  for (const m of src.matchAll(/<link\b([^>]*)>/gi)) {
    if ((attr(m[1], 'rel') || '').toLowerCase().split(/\s+/).includes('canonical')) { canonical = attr(m[1], 'href'); break; }
  }
  const h = /<html\b([^>]*)>/i.exec(src);
  const lang = h ? attr(h[1], 'lang') : null;
  const dir = h ? attr(h[1], 'dir') : null;
  const links = [];
  for (const m of src.matchAll(/<a\b([^>]*)>/gi)) {
    const href = attr(m[1], 'href');
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try { const u = new URL(href, pageUrl); if (/^https?:$/.test(u.protocol)) links.push(u.href); } catch { /* ignore */ }
  }
  const images = [];
  for (const m of src.matchAll(/<img\b([^>]*)>/gi)) images.push({ src: attr(m[1], 'src'), alt: attr(m[1], 'alt') });
  return { title: title || null, description: description || null, lang: lang || null, dir: dir || null, canonical: canonical || null, links: [...new Set(links)], images };
}

/** fetch with timeout; never throws. */
export async function request(url, { method = 'GET', timeoutMs = 10000, body = true } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'portfolio-health/1.0' } });
    let buf = null;
    if (method !== 'HEAD' && body) buf = Buffer.from(await res.arrayBuffer());
    else if (method !== 'HEAD') await res.body?.cancel();
    return { status: res.status, contentType: res.headers.get('content-type') || '', bytes: buf ? buf.length : Number(res.headers.get('content-length') || 0), text: buf ? buf.toString('utf8') : null, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, contentType: '', bytes: 0, text: null, ms: Date.now() - t0, error: e.cause?.code || e.name || String(e) };
  }
}

/** Run fn over items with limited concurrency. */
export async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decode(m[1]));

async function readSitemap(url, opts, seen = new Set(), depth = 0) {
  if (seen.has(url) || depth > 3) return [];
  seen.add(url);
  const r = await request(url, opts);
  if (r.status !== 200 || !r.text) return [];
  if (/<sitemapindex\b/i.test(r.text)) {
    const urls = [];
    for (const child of locs(r.text)) urls.push(...await readSitemap(child, opts, seen, depth + 1));
    return urls;
  }
  return locs(r.text);
}

const norm = (u) => { const x = new URL(u); x.hash = ''; return x.href; };

/**
 * Crawl a site. Returns {baseUrl (origin), source, pages, linkStatus}.
 * pages: [{url,status,bytes,ms,contentType,title,description,lang,dir,canonical,links,images,error?}]
 * linkStatus: {url -> status} for every internal link target (crawled or probed; 0 = unreachable).
 */
export async function crawl(baseUrl, { maxPages = 60, concurrency = 4, timeoutMs = 10000 } = {}) {
  const origin = new URL(baseUrl).origin;
  const opts = { timeoutMs };
  const same = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };

  let seeds = [];
  let source = 'sitemap';
  for (const sm of ['/sitemap-index.xml', '/sitemap.xml']) {
    seeds = (await readSitemap(new URL(sm, origin).href, opts)).filter(same);
    if (seeds.length) break;
  }
  const home = norm(new URL('/', origin).href);
  const pages = [];
  const seen = new Set();
  const fetchPage = async (url) => {
    const r = await request(url, opts);
    const page = { url, status: r.status, bytes: r.bytes, ms: r.ms, contentType: r.contentType, title: null, description: null, lang: null, dir: null, canonical: null, links: [], images: [] };
    if (r.error) page.error = r.error;
    if (r.text && /html/i.test(r.contentType)) Object.assign(page, parseHtml(r.text, url));
    return page;
  };

  if (!seeds.length) {
    source = 'home-links';
    const h = await fetchPage(home);
    pages.push(h); seen.add(home);
    seeds = h.links.filter(same);
  }
  const queue = [];
  for (const s of [home, ...seeds]) { const n = norm(s); if (!seen.has(n)) { seen.add(n); queue.push(n); } }
  pages.push(...await pool(queue.slice(0, Math.max(0, maxPages - pages.length)), concurrency, fetchPage));

  const linkStatus = {};
  for (const p of pages) linkStatus[p.url] = p.status;
  const probe = new Set();
  for (const p of pages) for (const l of p.links) if (same(l)) { const n = norm(l); if (!(n in linkStatus)) probe.add(n); }
  await pool([...probe], concurrency, async (u) => {
    let r = await request(u, { ...opts, method: 'HEAD' });
    if (r.status === 0 || r.status >= 400) r = await request(u, { ...opts, body: false });
    linkStatus[u] = r.status;
  });
  return { baseUrl: origin, source, pages, linkStatus };
}
