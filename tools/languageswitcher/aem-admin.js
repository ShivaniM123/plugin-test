/* eslint-disable import/no-unresolved */
import { Queue } from 'https://da.live/nx/public/utils/tree.js';

const AEM_ORIGIN = 'https://admin.hlx.page';

/**
 * Prefer actions.daFetch (DA session auth). Fall back to Bearer token + fetch.
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
    },
  });
}

export function canUseAemAdmin(actions, token) {
  return Boolean(createAemFetcher(actions, token));
}

export function buildAemPageRef(org, repo, branch, pathSegments) {
  const sitePath = pathSegments.length ? `/${pathSegments.join('/')}` : '';
  return {
    org, repo, branch, sitePath,
  };
}

function buildAdminUrl(ref, action) {
  return `${AEM_ORIGIN}/${action}/${ref.org}/${ref.repo}/${ref.branch}${ref.sitePath}`;
}

async function runAemQueue(pages, worker) {
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
 * Preview-only step from locales tools/locales/index.js publishPages.
 */
export async function previewPages(pages, aemFetch) {
  const worker = async (page) => {
    try {
      const resp = await aemFetch(buildAdminUrl(page, 'preview'), { method: 'POST' });
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
  return runAemQueue(pages, worker);
}

/**
 * Full publish flow from locales tools/locales/index.js publishPages.
 */
export async function publishPages(pages, aemFetch) {
  const worker = async (page) => {
    try {
      let resp = await aemFetch(buildAdminUrl(page, 'preview'), { method: 'POST' });
      if (resp.status === 200) {
        resp = await aemFetch(buildAdminUrl(page, 'live'), { method: 'POST' });
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
  return runAemQueue(pages, worker);
}

export function summarizeAemResults(pages) {
  const ok = pages.filter((p) => p.status === 200).length;
  const failed = pages.filter((p) => p.status !== 200);
  const detail = failed[0]?.error
    || (failed[0]?.status ? `HTTP ${failed[0].status}` : '');
  return { ok, total: pages.length, detail };
}
