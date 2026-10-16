import http from 'node:http';

export function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

export const page = ({ title = 'T', desc = true, lang = 'en', dir = '', canonical = true, body = '' } = {}) =>
  `<!doctype html><html${lang ? ` lang="${lang}"` : ''}${dir ? ` dir="${dir}"` : ''}><head>` +
  (title === null ? '' : `<title>${title}</title>`) +
  (desc ? '<meta name="description" content="d">' : '') +
  (canonical ? '<link rel="canonical" href="http://x/">' : '') +
  `</head><body>${body}</body></html>`;

/** Server standing in for third-party sites (a different origin from the site). */
export function externalServer() {
  return listen((req, res) => {
    const p = req.url;
    if (p === '/ok') { res.writeHead(200).end('ok'); return; }
    if (p === '/forbidden') { res.writeHead(403).end(); return; }
    if (p === '/gone') { res.writeHead(404).end(); return; }
    if (p === '/head405') { res.writeHead(req.method === 'HEAD' ? 405 : 200).end(); return; }
    res.writeHead(404).end();
  });
}

/** Tiny fake site. opts.sitemap=false removes sitemaps (home-link fallback). */
export async function fakeSite(ext, { sitemap = true } = {}) {
  const xml = (urls, base) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${base}${u}</loc></url>`).join('')}</urlset>`;
  const pages = {
    '/': page({ title: 'Home', body: `<a href="/broken">b</a><a href="/notitle">n</a><a href="/ar/">ar</a><a href="/dup">d</a><a href="/big">big</a><a href="/cv.pdf">cv</a>` +
      `<a href="${ext}/ok">ok</a><a href="${ext}/forbidden">f</a><a href="${ext}/gone">g</a><a href="${ext}/head405">h</a>` }),
    '/broken': page({ title: 'Broken', body: '<a href="/missing-page">dead</a>' }),
    '/notitle': page({ title: null, desc: false, canonical: false, body: '<img src="/a.png"><img src="/b.png" alt="">' }),
    '/ar/': page({ title: 'عربي', lang: 'ar' }),
    '/dup': page({ title: 'Home' }),
    '/big': page({ title: 'Big', body: 'x'.repeat(2 * 1024 * 1024) }),
  };
  const s = await listen((req, res) => {
    const path = req.url.split('?')[0];
    const base = `http://${req.headers.host}`;
    if (sitemap && path === '/sitemap-index.xml') { res.writeHead(200, { 'content-type': 'application/xml' }).end(`<sitemapindex><sitemap><loc>${base}/sitemap-0.xml</loc></sitemap><sitemap><loc>${base}/sitemap-1.xml</loc></sitemap></sitemapindex>`); return; }
    if (sitemap && path === '/sitemap-0.xml') { res.writeHead(200, { 'content-type': 'application/xml' }).end(xml(['/', '/broken', '/notitle'], base)); return; }
    if (sitemap && path === '/sitemap-1.xml') { res.writeHead(200, { 'content-type': 'application/xml' }).end(xml(['/ar/', '/dup', '/big', '/missing-page'], base)); return; }
    if (path === '/cv.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4'); return; }
    if (path === '/wrong.pdf') { res.writeHead(200, { 'content-type': 'text/html' }).end('<p>oops</p>'); return; }
    if (pages[path]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pages[path]); return; }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>');
  });
  return s;
}
