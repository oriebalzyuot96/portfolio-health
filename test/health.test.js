import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawl, parseHtml } from '../src/crawl.js';
import { checkPages, checkExternalLinks, checkRequiredFiles, runChecks } from '../src/checks.js';
import { renderMarkdown, renderJson, summarize } from '../src/report.js';
import { externalServer, fakeSite, listen, page } from './fake-site.js';

let ext, site, result, issues;
const cfg = { requiredFiles: ['/cv.pdf'], timeoutMs: 5000, concurrency: 4 };
const find = (rule, urlPart) => issues.filter((i) => i.rule === rule && (!urlPart || i.url.includes(urlPart)));

before(async () => {
  ext = await externalServer();
  site = await fakeSite(ext.url);
  result = await crawl(site.url, { timeoutMs: 5000 });
  issues = await runChecks(result, cfg);
});
after(async () => { await site.close(); await ext.close(); });

test('parseHtml extracts metadata, links and images', () => {
  const p = parseHtml(page({ title: 'A &amp; B', lang: 'ar', dir: 'rtl', body: '<a href="/x#f">x</a><a href="mailto:a@b.c">m</a><img src="i.png" alt="hi"><img src="j.png">' }), 'http://h/p/');
  assert.equal(p.title, 'A & B');
  assert.equal(p.description, 'd');
  assert.equal(p.lang, 'ar');
  assert.equal(p.dir, 'rtl');
  assert.equal(p.canonical, 'http://x/');
  assert.deepEqual(p.links, ['http://h/x#f']);
  assert.deepEqual(p.images, [{ src: 'i.png', alt: 'hi' }, { src: 'j.png', alt: null }]);
});

test('sitemap-index is followed to child sitemaps', () => {
  assert.equal(result.source, 'sitemap');
  const urls = result.pages.map((p) => p.url.replace(site.url, ''));
  for (const u of ['/', '/broken', '/notitle', '/ar/', '/dup', '/big', '/missing-page']) assert.ok(urls.includes(u), u);
});

test('falls back to home page links without a sitemap', async () => {
  const s = await fakeSite(ext.url, { sitemap: false });
  try {
    const r = await crawl(s.url, { timeoutMs: 5000 });
    assert.equal(r.source, 'home-links');
    assert.ok(r.pages.some((p) => p.url.endsWith('/broken')));
  } finally { await s.close(); }
});

test('maxPages is honoured', async () => {
  const r = await crawl(site.url, { maxPages: 2, timeoutMs: 5000 });
  assert.equal(r.pages.length, 2);
});

test('page-status flags 404', () => assert.equal(find('page-status', '/missing-page')[0].severity, 'error'));
test('missing-title', () => assert.equal(find('missing-title', '/notitle').length, 1));
test('missing-description', () => assert.equal(find('missing-description', '/notitle')[0].severity, 'warn'));
test('missing-lang', () => {
  const r = { baseUrl: 'http://h', pages: [{ url: 'http://h/', status: 200, bytes: 1, contentType: 'text/html', title: 't', description: 'd', lang: null, dir: null, canonical: 'c', links: [], images: [] }], linkStatus: {} };
  assert.equal(checkPages(r).filter((i) => i.rule === 'missing-lang').length, 1);
});
test('arabic-page-dir', () => { assert.equal(find('arabic-page-dir', '/ar/').length, 1); assert.equal(find('arabic-page-dir').length, 1); });
test('duplicate-title', () => assert.equal(find('duplicate-title').length, 2));
test('missing-canonical', () => assert.equal(find('missing-canonical', '/notitle').length, 1));
test('img-alt-missing only when alt attribute absent', () => {
  const m = find('img-alt-missing');
  assert.equal(m.length, 1);
  assert.match(m[0].message, /a\.png/);
});
test('broken-internal-link', () => {
  const m = find('broken-internal-link');
  assert.equal(m.length, 1);
  assert.ok(m[0].url.endsWith('/broken'));
  assert.equal(m[0].severity, 'error');
});
test('broken-external-link: warn, 403 is could-not-verify, HEAD 405 falls back to GET', () => {
  const m = find('broken-external-link');
  assert.ok(m.every((i) => i.severity === 'warn'));
  assert.equal(m.length, 2);
  assert.ok(m.some((i) => /forbidden returned 403: could not verify/.test(i.message)));
  assert.ok(m.some((i) => /gone returns 404/.test(i.message)));
  assert.ok(!m.some((i) => /head405|\/ok/.test(i.message)));
});
test('external check uses an injectable probe and 429 is could-not-verify', async () => {
  const r = { baseUrl: 'http://h', pages: [{ url: 'http://h/', links: ['http://other/a', 'http://other/b'] }], linkStatus: {} };
  const out = await checkExternalLinks(r, {}, async (u) => (u.endsWith('a') ? 429 : 0));
  assert.match(out[0].message, /could not verify/);
  assert.match(out[1].message, /unreachable/);
});
test('allow-list skips URLs', async () => {
  const out = await checkExternalLinks(result, { allow: [ext.url] });
  assert.equal(out.length, 0);
});
test('required-file passes for a real PDF', () => assert.equal(find('required-file').length, 0));
test('required-file flags wrong content-type and missing file', async () => {
  const out = await checkRequiredFiles(result, { requiredFiles: ['/wrong.pdf', '/nope.pdf'], timeoutMs: 5000 });
  assert.equal(out.length, 2);
  assert.match(out[0].message, /Content-Type/);
  assert.match(out[1].message, /404/);
});
test('page-weight warns over 1.5 MB', () => {
  const m = find('page-weight');
  assert.equal(m.length, 1);
  assert.ok(m[0].url.endsWith('/big'));
  assert.equal(m[0].severity, 'warn');
});

test('report renders markdown and json with summary', () => {
  const s = summarize(issues);
  assert.ok(s.error > 0 && s.warn > 0 && s.total === issues.length);
  const md = renderMarkdown(result, issues);
  assert.match(md, /# Portfolio health report/);
  assert.match(md, /\*\*FAIL\*\*/);
  assert.match(md, /\| broken-internal-link \|/);
  const js = JSON.parse(renderJson(result, issues));
  assert.equal(js.summary.error, s.error);
  assert.equal(js.issues.length, issues.length);
  assert.match(renderMarkdown(result, []), /No issues found/);
});

function runCli(args, cwd) {
  return new Promise((resolve) => execFile(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.js'), ...args], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
}

test('CLI exits 1 on errors and writes reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ requiredFiles: ['/cv.pdf'], timeoutMs: 5000 }));
  const r = await runCli([site.url, '--config', join(dir, 'c.json'), '--out', join(dir, 'out')], dir);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.ok(existsSync(join(dir, 'out', 'report.md')));
  assert.ok(JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8')).summary.error > 0);
});

test('CLI exits 0 on a healthy site (warnings allowed)', async () => {
  const good = await listen((req, res) => {
    if (req.url === '/cv.pdf') res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF');
    else if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(page({ title: 'Ok', body: '<a href="/cv.pdf">cv</a>' }));
    else res.writeHead(404).end();
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ph-'));
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ requiredFiles: ['/cv.pdf'], timeoutMs: 5000 }));
    const r = await runCli([good.url, '--config', join(dir, 'c.json'), '--out', join(dir, 'out'), '--max-pages', '5'], dir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { await good.close(); }
});
