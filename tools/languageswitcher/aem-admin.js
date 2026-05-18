/* eslint-disable import/no-unresolved */
import { Queue } from 'https://da.live/nx/public/utils/tree.js';

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
export function createAemFetcher(actions, token) {
  if (typeof actions?.daFetch === 'function') {
    return (url, opts) => actions.daFetch(url, opts);
  }
  if (!token) return null;
  return (url, opts = {}) => fetch(url, {
    ...opts,
    headers: {
      ...opts.headers,
      Authorization: `Bearer ${token}`,
      'x-content-source-authorization': `Bearer ${token}`,
    },
  });
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
      let resp = await aemFetch(`${AEM_ORIGIN}/preview${page.path}`, { method: 'POST' });
      if (resp.status === 200) {
        resp = await aemFetch(`${AEM_ORIGIN}/live${page.path}`, { method: 'POST' });
      }
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

export function liveUrlsFromPages(pages) {
  return pages.map((p) => p.resp?.live?.url).filter(Boolean);
}

export function summarizeBulkResult(pages, label) {
  const ok = pages.filter((p) => p.status === 200).length;
  const total = pages.length;
  if (!total) return `No pages to ${label}.`;
  if (ok === total) return `${ok} of ${total} page(s) ${label}.`;
  const failed = pages.find((p) => p.status !== 200);
  const detail = failed?.error || (failed?.status ? `HTTP ${failed.status}` : '');
  return `${ok} of ${total} page(s) ${label}.${detail ? ` (${detail})` : ''}`;
}
