/* eslint-disable import/no-unresolved */
import { Queue } from 'https://da.live/nx/public/utils/tree.js';
import { attachPermissionsFromHeaders } from './da-permissions.js';

const AEM_ORIGIN = 'https://admin.hlx.page';

/**
 * Same path shape as da-locale-tools/tools/locales (newAEMFullPath).
 */
export function buildAemAdminPath(org, repo, pathSegments) {
  const sitePath = pathSegments.length ? `/${pathSegments.join('/')}` : '';
  return `/${org}/${repo}/main${sitePath}`;
}

/**
 * Prefer actions.daFetch; fall back to Bearer token (locales uses fetch + Authorization).
 */
function wrapWithPermissions(fetcher) {
  return async (url, opts) => {
    const resp = await fetcher(url, opts);
    return attachPermissionsFromHeaders(resp);
  };
}

export function createAemFetcher(actions, token) {
  if (typeof actions?.daFetch === 'function') {
    return wrapWithPermissions((url, opts) => actions.daFetch(url, opts));
  }
  if (!token) return null;
  return wrapWithPermissions((url, opts = {}) => fetch(url, {
    ...opts,
    headers: {
      ...opts.headers,
      Authorization: `Bearer ${token}`,
      'x-content-source-authorization': `Bearer ${token}`,
    },
  }));
}

/**
 * Parse admin x-error header (from da-live blocks/edit/utils/helpers.js).
 */
export function parseAemError(xError) {
  if (!xError) return '';
  if (xError.includes('PDF')) {
    const [seg1, seg2] = xError.split(': ').slice(-2);
    return `${seg1}: ${seg2}`;
  }
  if (xError.includes('MP4')) {
    const [seg1] = xError.split(': ').slice(-2);
    return seg1;
  }
  if (xError.includes('Image')) {
    return xError.split(': ').pop().replace('.00', '');
  }
  return xError.replace('[admin] ', '');
}

export function isAccessDeniedStatus(status) {
  return status === 401 || status === 403;
}

/**
 * POST to admin.hlx.page — aligned with da-live saveToAem().
 * @param {string} adminPath - /org/repo/main/locale/page
 * @param {'preview'|'live'} action
 * @param {Function} aemFetch
 */
export async function postToAem(adminPath, action, aemFetch) {
  const segments = String(adminPath || '').replace(/^\//, '').toLowerCase().split('/');
  const owner = segments[0];
  const repo = segments[1];
  const aemPath = segments.slice(3).join('/');

  const url = `${AEM_ORIGIN}/${action}/${owner}/${repo}/main/${aemPath}`;
  const resp = await aemFetch(url, { method: 'POST' });

  if (!resp.ok) {
    const authErr = isAccessDeniedStatus(resp.status);
    const message = authErr ? `Not authorized to ${action}` : `Error during ${action}`;
    const xerror = resp.headers?.get?.('x-error');
    const details = xerror && !authErr ? parseAemError(xerror) : undefined;
    return {
      ok: false,
      status: resp.status,
      action,
      message,
      details,
      authErr,
    };
  }

  try {
    return { ok: true, status: resp.status, json: await resp.json() };
  } catch {
    return { ok: true, status: resp.status, json: null };
  }
}

function applyAemResult(page, result, { step = 'preview' } = {}) {
  page.status = result.status;
  if (result.ok) {
    page.resp = result.json;
    page.error = undefined;
    page.adminMessage = undefined;
    if (step === 'preview') page.failedStep = null;
    return;
  }
  page.resp = null;
  page.error = result.details || result.message;
  page.adminMessage = result.message;
  page.failedStep = step;
}

async function runQueuedPages(pages, worker) {
  const queue = new Queue(worker, 5);

  return new Promise((resolve) => {
    const throttle = setInterval(() => {
      const next = pages.find((page) => !page.inProgress && !page.done);
      if (next) {
        next.inProgress = true;
        queue.push(next);
      } else if (pages.every((page) => page.done)) {
        clearInterval(throttle);
        resolve(pages);
      }
    }, 250);
  });
}

/**
 * Preview — da-live handleAction('preview') → saveToAem(path, 'preview').
 */
export async function previewPages(pages, aemFetch) {
  const worker = async (page) => {
    try {
      const result = await postToAem(page.path, 'preview', aemFetch);
      applyAemResult(page, result, { step: 'preview' });
    } catch (err) {
      page.status = 0;
      page.error = err.message || String(err);
      page.failedStep = 'preview';
    } finally {
      page.done = true;
      page.inProgress = false;
    }
  };
  return runQueuedPages(pages, worker);
}

/**
 * Publish — da-live handleAction('publish'): preview then live.
 */
export async function publishPages(pages, aemFetch) {
  const worker = async (page) => {
    try {
      const previewResult = await postToAem(page.path, 'preview', aemFetch);
      page.previewStatus = previewResult.status;
      page.previewResp = previewResult.ok ? previewResult.json : null;

      if (!previewResult.ok) {
        applyAemResult(page, previewResult, { step: 'preview' });
        return;
      }

      const liveResult = await postToAem(page.path, 'live', aemFetch);
      applyAemResult(page, liveResult, { step: 'publish' });
    } catch (err) {
      page.status = 0;
      page.previewStatus = page.previewStatus ?? 0;
      page.error = err.message || String(err);
      page.failedStep = page.failedStep || 'preview';
    } finally {
      page.done = true;
      page.inProgress = false;
    }
  };
  return runQueuedPages(pages, worker);
}

export function liveUrlsFromPages(pages) {
  return pages.map((p) => p.resp?.live?.url).filter(Boolean);
}

function formatLocaleCode(locale) {
  const s = String(locale ?? '').trim();
  return s ? s.toLowerCase() : '?';
}

/** Bulk UI only — HTTP status, not long AEM x-error text. */
function pageBulkErrorKey(page, { usePreviewStatus = false } = {}) {
  const status = usePreviewStatus ? page.previewStatus : page.status;
  if (status) return `HTTP ${status}`;
  return 'failed';
}

function groupPagesByError(pages, opts = {}) {
  const byError = new Map();
  pages.forEach((p) => {
    const detail = pageBulkErrorKey(p, opts);
    const langs = byError.get(detail) || [];
    langs.push(formatLocaleCode(p.locale));
    byError.set(detail, langs);
  });
  return byError;
}

const HTTP_STATUS_REASON = {
  401: 'not authorized',
  403: 'not authorized',
  404: 'page not found',
  500: 'server error',
  502: 'server error',
  503: 'service unavailable',
};

function formatFriendlyReason(detail) {
  const text = String(detail || '').trim();
  const match = /^HTTP (\d+)$/.exec(text);
  if (match) return HTTP_STATUS_REASON[match[1]] || text.toLowerCase();
  return text;
}

function pluralWord(count, singular) {
  return count === 1 ? singular : `${singular}(s)`;
}

function formatCountLine(ok, total, label, unit = 'page') {
  return `${ok} of ${total} ${pluralWord(total, unit)} ${label}.`;
}

function formatLocaleBraceList(localeCodes) {
  const paths = localeCodes
    .map((loc) => (String(loc).startsWith('/') ? loc : `/${loc}`))
    .join(', ');
  return `{ ${paths} }`;
}

function formatPageNotFoundPhrase(localeCount) {
  return `${pluralWord(localeCount, 'page')} not found`;
}

function formatPublishFailureDetailLine(detail, localeCount) {
  const reason = formatFriendlyReason(detail);
  if (reason === 'page not found') {
    return `Error: ${formatPageNotFoundPhrase(localeCount)}.`;
  }
  if (reason === 'not authorized') {
    return `Error: ${pluralWord(localeCount, 'page')} not authorized.`;
  }
  return `Error: ${reason}.`;
}

function formatPreviewFailureDetailLine(detail, localeCount) {
  const reason = formatFriendlyReason(detail);
  if (reason === 'page not found') {
    return `Error: ${formatPageNotFoundPhrase(localeCount)}.`;
  }
  if (reason === 'not authorized') {
    return `Error: ${pluralWord(localeCount, 'page')} not authorized.`;
  }
  return `Error: ${reason}.`;
}

function formatPreviewFailedLines(pages) {
  const lines = [];
  [...groupPagesByError(pages).entries()].forEach(([detail, langs]) => {
    const locales = formatLocaleBraceList(langs);
    const langLabel = pluralWord(langs.length, 'language');
    lines.push(`Could not preview for ${locales} ${langLabel}`);
    lines.push(formatPreviewFailureDetailLine(detail, langs.length));
  });
  return lines;
}

function formatPublishSkippedLines(pages) {
  const lines = [];
  [...groupPagesByError(pages, { usePreviewStatus: true }).entries()].forEach(([detail, langs]) => {
    const locales = formatLocaleBraceList(langs);
    const langLabel = pluralWord(langs.length, 'language');
    lines.push(`Publish skipped for ${locales} ${langLabel}`);
    lines.push(formatPublishFailureDetailLine(detail, langs.length));
  });
  return lines;
}

function formatPublishFailedLines(pages) {
  const lines = [];
  [...groupPagesByError(pages).entries()].forEach(([detail, langs]) => {
    const locales = formatLocaleBraceList(langs);
    const langLabel = pluralWord(langs.length, 'language');
    lines.push(`Could not publish for ${locales} ${langLabel}`);
    lines.push(formatPublishFailureDetailLine(detail, langs.length));
  });
  return lines;
}

function isPreviewFailure(page) {
  return page?.failedStep === 'preview'
    || (page?.previewStatus != null && page.previewStatus !== 200);
}

function pageDeniedStatus(page) {
  if (isPreviewFailure(page) && page.previewStatus) return page.previewStatus;
  return page.status;
}

function isAuthFailure(page) {
  return isAccessDeniedStatus(pageDeniedStatus(page));
}

export function allPagesAccessDenied(pages) {
  return (pages?.length ?? 0) > 0
    && pages.every((p) => isAccessDeniedStatus(pageDeniedStatus(p)));
}

/** User-facing message when preview/publish is not allowed (no token or HTTP 401/403). */
export function permissionDeniedMessage(action) {
  const verb = action === 'publish' ? 'publish' : 'preview';
  return `You don't have permission to ${verb}. Contact your administrator.`;
}

function summarizePublishResult(pages, label, action = 'publish') {
  const total = pages?.length ?? 0;
  const failed = pages.filter((p) => p.status !== 200);
  const ok = total - failed.length;

  if (!failed.length) {
    return formatCountLine(ok, total, label, 'language');
  }

  if (failed.some(isAuthFailure)) {
    return permissionDeniedMessage(action);
  }

  const previewFailed = failed.filter(isPreviewFailure);
  const publishFailed = failed.filter((p) => !isPreviewFailure(p));
  const lines = [formatCountLine(ok, total, label, 'language')];

  if (previewFailed.length) {
    lines.push(...formatPublishSkippedLines(previewFailed));
  }
  if (publishFailed.length) {
    lines.push(...formatPublishFailedLines(publishFailed));
  }

  return lines.join('\n');
}

export function summarizeBulkResult(pages, label, action = 'preview') {
  const total = pages?.length ?? 0;
  if (!total) return `No pages to ${label.replace(/ed$/, '')}.`;

  const failed = pages.filter((p) => p.status !== 200);
  const ok = total - failed.length;

  if (!failed.length) {
    return formatCountLine(ok, total, label);
  }

  if (allPagesAccessDenied(pages) || failed.some(isAuthFailure)) {
    return permissionDeniedMessage(action);
  }

  if (action === 'publish') {
    return summarizePublishResult(pages, label, action);
  }

  const lines = [formatCountLine(ok, total, label), ...formatPreviewFailedLines(failed)];
  return lines.join('\n');
}
