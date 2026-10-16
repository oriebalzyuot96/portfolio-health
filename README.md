# portfolio-health

Zero-dependency health checker (Node 24, ESM) for a personal portfolio site. Finds broken links, missing metadata and missing files before visitors do. Default target: https://oriebalzyuot96.github.io.

## What it checks

| Rule | Severity | Meaning |
|---|---|---|
| page-status | error | page returned non-200 or was unreachable |
| missing-title, missing-lang | error | no `<title>` / no `lang` on `<html>` |
| missing-description, missing-canonical | warn | metadata absent |
| arabic-page-dir | error | `lang=ar` page without `dir=rtl` |
| duplicate-title | warn | same title on several pages |
| img-alt-missing | warn | `<img>` without an `alt` attribute (empty alt is accepted) |
| broken-internal-link | error | same-origin link target is >= 400 or unreachable |
| broken-external-link | warn | external link fails (HEAD, then GET fallback); 403/429 are reported as "could not verify" |
| required-file | error | configured files (default `/Orieb-Alzyuot-CV.pdf`) must be 200 with `application/pdf` |
| page-weight | warn | page over 1.5 MB |

Pages come from `/sitemap-index.xml` (child sitemaps are followed) or `/sitemap.xml`; if neither exists, the home page links are used.

## Run

```
node src/cli.js                                   # live portfolio
node src/cli.js http://localhost:4321 --max-pages 20
node src/cli.js https://example.com --config portfolio-health.json --out reports
```

Writes `reports/report.md` and `reports/report.json`. Exit code 1 if any error-level issue exists, 2 on a usage or config failure. `npm test` runs fully offline against local servers.

## Config (`portfolio-health.json`)

`baseUrl`, `maxPages`, `concurrency`, `timeoutMs`, `requiredFiles`, `pageWeightBytes`, and `allow` (URL prefixes skipped by page and link checks, for example sites that block bots). CLI arguments override the file.

## Schedule

`.github/workflows/health.yml` runs weekly (Mondays 06:00 UTC) and on manual dispatch, uploads `reports/` as the `health-report` artifact, and fails the run on errors. No secrets are needed.

## Limits

- Static HTML only; no JavaScript rendering. Parsing uses simple regexes (see `src/crawl.js`), not a full HTML parser.
- External sites may block bots or rate-limit; those show as warnings, never errors.
- Only the first `maxPages` pages are crawled.
