/* eslint-disable import/no-unresolved */
import { Queue } from 'https://da.live/nx/public/utils/tree.js';

const AEM_ORIGIN = 'https://admin.hlx.page';

let aemToken;

export function setAemToken(token) {
  aemToken = token;
}

export function buildAemAdminPath(org, repo, pathSegments) {
  const sitePath = pathSegments.length ? `/${pathSegments.join('/')}` : '';
  return `/${org}/${repo}/main${sitePath}`;
}

async function runAemQueue(pages, request) {
  const opts = { method: 'POST', headers: { Authorization: `Bearer ${aemToken}` } };
  const queue = new Queue(request, 5);

  return new Promise((resolve) => {
    const throttle = setInterval(() => {
      const nextUrl = pages.find((url) => !url.inProgress);
      if (nextUrl) {
        nextUrl.inProgress = true;
        queue.push(nextUrl);
      } else {
        const finished = pages.every((url) => url.status);
        if (finished) {
          clearInterval(throttle);
          resolve(pages);
        }
      }
    }, 250);
  });
}

/**
 * Preview-only step from locales tools/locales/index.js publishPages.
 */
export async function previewPages(pages) {
  const opts = { method: 'POST', headers: { Authorization: `Bearer ${aemToken}` } };

  const preview = async (url) => {
    const resp = await fetch(`${AEM_ORIGIN}/preview${url.path}`, opts);
    url.status = resp.status;
    try {
      url.resp = await resp.json();
    } catch {
      url.resp = null;
    }
  };

  return runAemQueue(pages, preview);
}

/**
 * Full publish flow from locales tools/locales/index.js publishPages.
 */
export async function publishPages(pages) {
  const opts = { method: 'POST', headers: { Authorization: `Bearer ${aemToken}` } };

  const publish = async (url) => {
    let resp = await fetch(`${AEM_ORIGIN}/preview${url.path}`, opts);
    if (resp.status === 200) {
      resp = await fetch(`${AEM_ORIGIN}/live${url.path}`, opts);
    }
    url.status = resp.status;
    try {
      url.resp = await resp.json();
    } catch {
      url.resp = null;
    }
  };

  return runAemQueue(pages, publish);
}
