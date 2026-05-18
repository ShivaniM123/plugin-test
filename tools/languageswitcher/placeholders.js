/* eslint-disable import/no-unresolved, max-len, no-restricted-syntax, no-continue */

const DEFAULT_SHEET = 'language-switcher';

function normalizeSheetPath(p) {
  if (p == null || p === '') return '';
  let s = String(p).trim();
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\.html$/i, '');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

export function pathAfterLocale(segments) {
  if (segments.length < 2) return '';
  return normalizeSheetPath(`/${segments.slice(1).join('/')}`);
}

export function extractLanguageSwitcherRows(json, sheetName) {
  if (!json || typeof json !== 'object') return { rows: [] };

  const sheet = json[sheetName];
  if (sheet && Array.isArray(sheet.data)) {
    return { rows: sheet.data.filter((r) => r && typeof r === 'object') };
  }

  if (json[':type'] === 'sheet' && Array.isArray(json.data)) {
    return { rows: json.data.filter((r) => r && typeof r === 'object') };
  }

  return { rows: [] };
}

export function detectLocaleColumnKeys(rows) {
  const keys = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'string' || !v.trim().startsWith('/')) continue;
      if (!/^[a-z][a-z0-9-]*$/i.test(k) || k.length > 24) continue;
      keys.add(k);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function resolvePathWithRows(rows, fromLoc, toLoc, afterLocalePath) {
  const p = normalizeSheetPath(afterLocalePath);
  const fromKey = fromLoc;
  const toKey = toLoc;

  const sorted = rows
    .filter((r) => r && typeof r === 'object' && r[fromKey])
    .map((row) => {
      const base = normalizeSheetPath(row[fromKey]);
      return { row, base, len: base.length };
    })
    .filter((x) => x.base)
    .sort((a, b) => b.len - a.len);

  for (const { row, base, len } of sorted) {
    const baseSlash = `${base}/`;
    if (p === base || p.startsWith(baseSlash)) {
      const targetBase = normalizeSheetPath(row[toKey]);
      if (!targetBase) return null;
      const suffix = p.length > len ? p.slice(len) : '';
      return `/${toLoc}${normalizeSheetPath(`${targetBase}${suffix}`)}`;
    }
  }
  return null;
}

export function buildPlaceholdersUrl(branch, org, repo, tier, directoryPrefix = '') {
  const domain = tier === 'live' ? 'aem.live' : 'aem.page';
  const base = `https://${branch}--${repo}--${org}.${domain}`;
  const sub = directoryPrefix ? `${directoryPrefix.replace(/\/$/, '')}/` : '';
  return `${base}/${sub}placeholders.json`;
}

const ADMIN_PLACEHOLDERS = 'https://admin.da.live/source';

export function buildPlaceholderDirectoryCandidates(sitePath) {
  const candidates = [''];
  if (!sitePath || typeof sitePath !== 'string') return candidates;
  const trimmed = sitePath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return candidates;
  const parts = trimmed.split('/').filter(Boolean);
  const maxDepth = parts.length > 1 ? parts.length - 1 : parts.length;
  for (let i = 0; i < maxDepth; i += 1) {
    candidates.push(parts.slice(0, i + 1).join('/'));
  }
  return [...new Set(candidates)];
}

function sheetHasLanguageColumns(json, sheetName) {
  const { rows } = extractLanguageSwitcherRows(json, sheetName);
  if (!rows.length) return false;
  return detectLocaleColumnKeys(rows).length > 0;
}

export async function fetchLanguageSwitcherRows(
  branch,
  org,
  repo,
  tier,
  sheetName = DEFAULT_SHEET,
  actions = null,
  sitePath = '',
) {
  /* eslint-disable no-await-in-loop */
  const parseRows = async (resp, sourceLabel) => {
    if (!resp.ok) throw new Error(`${sourceLabel} HTTP ${resp.status}`);
    const json = await resp.json();
    if (!sheetHasLanguageColumns(json, sheetName)) {
      throw new Error('no language-switcher columns');
    }
    return { rows: extractLanguageSwitcherRows(json, sheetName).rows, url: sourceLabel };
  };

  const dirs = buildPlaceholderDirectoryCandidates(sitePath);
  const errors = [];

  const trySource = async (label, getResp) => {
    try {
      const resp = await getResp();
      if (!resp.ok) {
        errors.push(`${label}: HTTP ${resp.status}`);
        return null;
      }
      try {
        return await parseRows(resp, label);
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
        return null;
      }
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      return null;
    }
  };

  for (const dir of dirs) {
    const previewUrl = buildPlaceholdersUrl(branch, org, repo, tier, dir);
    const ok = await trySource(previewUrl, () => fetch(previewUrl, { credentials: 'omit' }));
    if (ok) return ok;

    if (actions?.daFetch) {
      const adminPath = dir ? `${dir}/placeholders.json` : 'placeholders.json';
      const adminUrl = `${ADMIN_PLACEHOLDERS}/${org}/${repo}/${adminPath}`;
      const adminOk = await trySource(adminUrl, () => actions.daFetch(adminUrl));
      if (adminOk) return adminOk;
    }
  }

  const summary = errors.length ? ` Tried: ${errors.slice(0, 4).join('; ')}${errors.length > 4 ? '…' : ''}` : '';
  /* eslint-enable no-await-in-loop */
  throw new Error(
    `Could not load placeholders.json with "${sheetName}" language columns.${summary}`,
  );
}

export { DEFAULT_SHEET };
