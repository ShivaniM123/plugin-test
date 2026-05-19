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
 * Preview-only — first step of locales publishPages (index.js).
 */
export async function previewPages(pages, aemFetch) {
  const worker = async (page) => {
    try {
      const resp = await aemFetch(`${AEM_ORIGIN}/preview${page.path}`, { method: 'POST' });
      page.status = resp.status;
      try {
        page.resp = await resp.json();
      } catch {
        page.resp = null;
      }
    } catch (err) {
      page.status = 0;
      page.error = err.message || String(err);
    } finally {
      page.done = true;
      page.inProgress = false;
    }
  };
  return runQueuedPages(pages, worker);
}

/**
 * Copied from da-locale-tools/tools/locales/index.js publishPages.
 */
export async function publishPages(pages, aemFetch) {
  const worker = async (page) => {
    try {
      const previewResp = await aemFetch(`${AEM_ORIGIN}/preview${page.path}`, { method: 'POST' });
      page.previewStatus = previewResp.status;
      try {
        page.previewResp = await previewResp.json();
      } catch {
        page.previewResp = null;
      }
      if (previewResp.status === 200) {
        const liveResp = await aemFetch(`${AEM_ORIGIN}/live${page.path}`, { method: 'POST' });
        page.status = liveResp.status;
        page.failedStep = liveResp.status === 200 ? null : 'publish';
        try {
          page.resp = await liveResp.json();
        } catch {
          page.resp = null;
        }
      } else {
        page.status = previewResp.status;
        page.failedStep = 'preview';
        page.resp = page.previewResp;
      }
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

function pageErrorDetail(page, { usePreviewStatus = false } = {}) {
  if (page?.error) return String(page.error);
  if (usePreviewStatus && page.previewStatus) return `HTTP ${page.previewStatus}`;
  if (page?.status) return `HTTP ${page.status}`;
  return 'failed';
}

function isPreviewFailure(page) {
  return page?.failedStep === 'preview'
    || (page?.previewStatus != null && page.previewStatus !== 200);
}

export function isAccessDeniedStatus(status) {
  return status === 401 || status === 403;
}

export function allPagesAccessDenied(pages) {
  return (pages?.length ?? 0) > 0 && pages.every((p) => isAccessDeniedStatus(p.status));
}

/** User-facing message when preview/publish is not allowed (no token or HTTP 401/403). */
export function permissionDeniedMessage(action) {
  const verb = action === 'publish' ? 'publish' : 'preview';
  return `You don't have permission to ${verb}. Contact your administrator.`;
}

function formatFailureList(pages, opts = {}) {
  return pages
    .map((p) => `${formatLocaleCode(p.locale)} ${pageErrorDetail(p, opts)}`)
    .join(', ');
}

function summarizePublishResult(pages, label) {
  const total = pages?.length ?? 0;
  const failed = pages.filter((p) => p.status !== 200);
  const ok = total - failed.length;

  if (!failed.length) {
    return `${ok} of ${total} page(s) ${label}.`;
  }

  const summary = `${ok} of ${total} page(s) ${label}.`;
  const previewFailed = failed.filter(isPreviewFailure);
  const publishFailed = failed.filter((p) => !isPreviewFailure(p));
  const lines = [summary];

  if (previewFailed.length) {
    lines.push(
      `Preview failed for ${formatFailureList(previewFailed, { usePreviewStatus: true })}, hence publish also failed.`,
    );
  }
  if (publishFailed.length) {
    lines.push(`Publish failed for ${formatFailureList(publishFailed)}.`);
  }

  return lines.join('\n');
}

export function summarizeBulkResult(pages, label, action = 'preview') {
  const total = pages?.length ?? 0;
  if (!total) return `No pages to ${label}.`;

  if (allPagesAccessDenied(pages)) {
    return permissionDeniedMessage(action);
  }

  const failed = pages.filter((p) => p.status !== 200);
  const ok = total - failed.length;

  if (!failed.length) {
    return `${ok} of ${total} page(s) ${label}.`;
  }

  if (action === 'publish') {
    return summarizePublishResult(pages, label);
  }

  const summary = `${ok} of ${total} page(s) ${label}.`;
  return `${summary}\nPreview failed for ${formatFailureList(failed)}.`;
}
