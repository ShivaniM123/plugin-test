/**
 * DA content permissions (x-da-actions / x-da-child-actions), aligned with
 * adobe/da-live blocks/shared/utils.js daFetch.
 */

const DA_ORIGIN = 'https://da.live';

/**
 * Parse x-da-actions or x-da-child-actions (e.g. "/=read,write").
 * @param {Headers} headers
 * @returns {string[]|null}
 */
export function parseDaActionsHeader(headers) {
  if (!headers?.get) return null;
  const raw = headers.get('x-da-child-actions') || headers.get('x-da-actions');
  if (!raw) return null;
  const actions = raw.split('=').pop();
  return actions ? actions.split(',').map((p) => p.trim()).filter(Boolean) : null;
}

/**
 * Attach resp.permissions like da-live daFetch (legacy fallback: read + write).
 * @param {Response} resp
 * @returns {Response}
 */
export function attachPermissionsFromHeaders(resp) {
  const parsed = parseDaActionsHeader(resp.headers);
  if (parsed) {
    resp.permissions = parsed;
    return resp;
  }
  if (resp.status === 401 || resp.status === 403) {
    resp.permissions = [];
    return resp;
  }
  resp.permissions = ['read', 'write'];
  return resp;
}

export function hasDaPermission(permissions, action) {
  return Array.isArray(permissions) && permissions.includes(action);
}

export function isAccessDeniedStatus(status) {
  return status === 401 || status === 403;
}

export function permissionDeniedMessageForAccess() {
  return "You don't have permission to access this content. Contact your administrator.";
}

export function permissionDeniedMessageForPublish() {
  return "You don't have permission to publish. Contact your administrator.";
}

/**
 * Build da.live/source URL for the current page (adds .html when needed).
 */
export function buildDaSourceUrl(org, repo, sitePath) {
  const base = `${DA_ORIGIN}/source/${org}/${repo}`;
  let rel = String(sitePath || '').replace(/^\/+/, '');
  if (!rel) return `${base}/`;
  const last = rel.split('/').pop() || '';
  const hasExt = /\.[a-z0-9]+$/i.test(last);
  if (!hasExt) rel = `${rel}.html`;
  return `${base}/${rel}`;
}

/**
 * Probe DA ACL for the open document via actions.daFetch (x-da-actions).
 * Preview/publish on admin.hlx.page are still enforced separately on click.
 *
 * @param {Function|null} daFetch
 * @param {string} org
 * @param {string} repo
 * @param {string} sitePath - path under org/repo (e.g. /en/page)
 * @returns {Promise<{
 *   authenticated: boolean,
 *   status: number,
 *   permissions: string[],
 *   canRead: boolean,
 *   canWrite: boolean,
 *   canPreview: boolean,
 *   canPublish: boolean,
 *   denied: boolean,
 *   message: string,
 * }>}
 */
export async function checkDaContentAccess(daFetch, org, repo, sitePath) {
  const noAuth = {
    authenticated: false,
    status: 0,
    permissions: [],
    canRead: false,
    canWrite: false,
    canPreview: false,
    canPublish: false,
    denied: true,
    message: '',
  };

  if (typeof daFetch !== 'function') {
    return noAuth;
  }

  const url = buildDaSourceUrl(org, repo, sitePath);
  let resp;
  try {
    resp = await daFetch(url, { method: 'GET' });
  } catch {
    return {
      ...noAuth,
      authenticated: true,
      denied: false,
      canRead: true,
      canWrite: true,
      canPreview: true,
      canPublish: true,
    };
  }

  attachPermissionsFromHeaders(resp);
  const permissions = resp.permissions || [];
  const denied = isAccessDeniedStatus(resp.status);
  const canRead = !denied && hasDaPermission(permissions, 'read');
  const canWrite = !denied && hasDaPermission(permissions, 'write');

  if (denied) {
    return {
      authenticated: true,
      status: resp.status,
      permissions,
      canRead: false,
      canWrite: false,
      canPreview: false,
      canPublish: false,
      denied: true,
      message: permissionDeniedMessageForAccess(),
    };
  }

  if (!canRead) {
    return {
      authenticated: true,
      status: resp.status,
      permissions,
      canRead: false,
      canWrite: false,
      canPreview: false,
      canPublish: false,
      denied: false,
      message: permissionDeniedMessageForAccess(),
    };
  }

  return {
    authenticated: true,
    status: resp.status,
    permissions,
    canRead: true,
    canWrite,
    canPreview: true,
    canPublish: canWrite,
    denied: false,
    message: canWrite ? '' : permissionDeniedMessageForPublish(),
  };
}
