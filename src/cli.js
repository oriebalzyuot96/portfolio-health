#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { crawl } from './crawl.js';
import { runChecks, DEFAULTS } from './checks.js';
import { renderMarkdown, renderJson, summarize } from './report.js';

function parseArgs(argv) {
  const a = { baseUrl: null, config: null, out: 'reports', maxPages: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--config') a.config = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--max-pages') a.maxPages = Number(argv[++i]);
    else if (v === '-h' || v === '--help') a.help = true;
    else if (v.startsWith('--')) throw new Error(`Unknown option ${v}`);
    else a.baseUrl = v;
  }
  return a;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log('Usage: portfolio-health [baseUrl] [--config portfolio-health.json] [--out reports] [--max-pages N]'); return 0; }
  const cfgPath = args.config || (existsSync('portfolio-health.json') ? 'portfolio-health.json' : null);
  const cfg = cfgPath ? JSON.parse(await readFile(cfgPath, 'utf8')) : {};
  const config = { ...DEFAULTS, baseUrl: 'https://oriebalzyuot96.github.io', ...cfg };
  if (args.baseUrl) config.baseUrl = args.baseUrl;
  if (args.maxPages) config.maxPages = args.maxPages;
  const result = await crawl(config.baseUrl, config);
  const issues = await runChecks(result, config);
  const meta = { generatedAt: new Date().toISOString() };
  await mkdir(args.out, { recursive: true });
  await writeFile(join(args.out, 'report.md'), renderMarkdown(result, issues, meta));
  await writeFile(join(args.out, 'report.json'), renderJson(result, issues, meta));
  const s = summarize(issues);
  console.log(`${result.baseUrl}: ${result.pages.length} pages, ${s.error} error(s), ${s.warn} warning(s). Reports in ${args.out}/`);
  return s.error > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 2; });
