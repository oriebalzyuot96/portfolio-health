export function summarize(issues) {
  const s = { error: 0, warn: 0, total: issues.length };
  for (const i of issues) s[i.severity] = (s[i.severity] || 0) + 1;
  return s;
}

export function renderJson(result, issues, meta = {}) {
  return JSON.stringify({ ...meta, baseUrl: result.baseUrl, pagesChecked: result.pages.length, summary: summarize(issues), issues }, null, 2);
}

export function renderMarkdown(result, issues, meta = {}) {
  const s = summarize(issues);
  const L = ['# Portfolio health report', '', `- Site: ${result.baseUrl}`, `- Generated: ${meta.generatedAt || new Date().toISOString()}`, `- Pages checked: ${result.pages.length} (discovered via ${result.source})`, `- Result: **${s.error ? 'FAIL' : 'PASS'}** - ${s.error} error(s), ${s.warn} warning(s)`, ''];
  if (!issues.length) return L.concat('No issues found.', '').join('\n');
  for (const sev of ['error', 'warn']) {
    const list = issues.filter((i) => i.severity === sev);
    if (!list.length) continue;
    L.push(`## ${sev === 'error' ? 'Errors' : 'Warnings'} (${list.length})`, '', '| Rule | URL | Message |', '|---|---|---|');
    for (const i of list) L.push(`| ${i.rule} | ${i.url} | ${i.message.replace(/\|/g, '\\|')} |`);
    L.push('');
  }
  return L.join('\n');
}
