/* eslint-disable import/no-unresolved, max-len, operator-linebreak, object-curly-newline */
/* eslint-disable no-restricted-syntax, no-continue, prefer-destructuring, no-console */
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  parseCurrentPage,
  buildAemPreviewUrl,
  buildDaHashUrl,
  pathnameToSegments,
  contextToDaUrl,
} from './locale-url-helper.js';
import {
  fetchLanguageSwitcherRows,
  resolvePathWithRows,
  pathAfterLocale,
  DEFAULT_SHEET,
  detectLocaleColumnKeys,
} from './placeholders.js';
import {
  createAemFetcher,
  buildAemAdminPath,
  previewPages,
  publishPages,
  summarizeBulkResult,
  permissionDeniedMessage,
} from './aem-admin.js';
import {
  checkDaContentAccess,
  permissionDeniedMessageForAccess,
  permissionDeniedMessageForPreview,
  permissionDeniedMessageForPublish,
} from './da-permissions.js';

const PRIMARY_LABEL_WITH_PICKER = 'Open page for selected language';
const LANG_SELECT_PLACEHOLDER = 'Select…';
const BULK_MESSAGE_SUCCESS_DISMISS_MS = 5000;

/** Always show locale codes in lowercase (avoids DA global strong { uppercase }). */
const formatLocaleDisplay = (locale) => {
  const s = String(locale ?? '').trim();
  return s ? s.toLocaleLowerCase('en') : '';
};

const openPageInLabel = (locale) => `Open page in ${formatLocaleDisplay(locale)}`;

const SETTINGS = {
  tier: 'page',
  branch: 'main',
  target: 'da-edit',
  daView: 'edit',
  placeholderSheetName: DEFAULT_SHEET,
  placeholderCacheTtlMs: 300000,
};

const DA_VIEWS = new Set(['edit', 'sheet', 'browse', 'config', 'media']);

function pickDaView(context) {
  const v = context?.view;
  if (typeof v !== 'string') return SETTINGS.daView;
  const head = v.replace(/^\//, '').split('/')[0];
  return DA_VIEWS.has(head) ? head : SETTINGS.daView;
}

function getUi() {
  return {
    statusEl: document.getElementById('status'),
    contentCardEl: document.getElementById('contentCard'),
    bulkMessageEl: document.getElementById('bulkMessage'),
    bulkFooter: document.getElementById('bulkFooter'),
    actionsEl: document.getElementById('actions'),
    langRow: document.getElementById('langRow'),
    langCombobox: document.getElementById('langCombobox'),
    langTrigger: document.getElementById('langSelectTrigger'),
    langMenu: document.getElementById('langSelectMenu'),
    langValue: document.getElementById('langSelectValue'),
    currentLocaleEl: document.getElementById('currentLocale'),
    currentLocaleValue: document.getElementById('currentLocaleValue'),
    openBtn: document.getElementById('open'),
    openLabel: document.getElementById('openLabel'),
    openAllBtn: document.getElementById('openAll'),
    previewAllBtn: document.getElementById('previewAll'),
    publishAllBtn: document.getElementById('publishAll'),
  };
}

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry?.expires > Date.now() && Array.isArray(entry.rows)) return entry.rows;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache(key, rows, ttlMs) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ rows, expires: Date.now() + ttlMs }));
  } catch {
    /* sessionStorage unavailable */
  }
}

function openUrlsInNewTabs(urls) {
  urls.filter(Boolean).forEach((href) => {
    window.open(typeof href === 'string' ? href : String(href), '_blank', 'noopener,noreferrer');
  });
}

function setBulkMessage(ui, text, opts = {}) {
  if (!ui.bulkMessageEl) return;
  const msg = String(text || '').trim();
  const isError = opts.isError === true;
  const isLoading = opts.isLoading === true;
  const isSuccess = opts.isSuccess === true;
  ui.bulkMessageEl.textContent = msg;
  ui.bulkMessageEl.hidden = !msg;
  ui.bulkMessageEl.classList.toggle('is-error', Boolean(isError && msg && !isLoading));
  ui.bulkMessageEl.classList.toggle('is-loading', Boolean(isLoading && msg));
  ui.bulkMessageEl.classList.toggle('is-success', Boolean(isSuccess && msg && !isLoading));
}

function setOpenLabel(ui, label) {
  const text = typeof label === 'string' && label.trim() ? label.trim() : PRIMARY_LABEL_WITH_PICKER;
  if (ui.openLabel) ui.openLabel.textContent = text;
  else if (ui.openBtn) ui.openBtn.textContent = text;
}

function setCurrentLocale(ui, locale) {
  if (!ui.currentLocaleEl) return;
  const loc = String(locale || '').trim();
  if (!loc) {
    ui.currentLocaleEl.hidden = true;
    return;
  }
  ui.currentLocaleEl.hidden = false;
  if (ui.currentLocaleValue) ui.currentLocaleValue.textContent = formatLocaleDisplay(loc);
}

function setUi(ui, actions, opts = {}) {
  const {
    status = '',
    statusIsWarning = false,
    bulkMessage = '',
    bulkMessageIsError = false,
    openUrl = null,
    canOpen = false,
    showContentCard = true,
    showLangRow = false,
    showOpenAll = false,
    showPreviewAll = true,
    showPublishAll = true,
    openDisabled = false,
    bulkDisabled = false,
    openPrimaryLabel,
    currentLocale,
    openAllClick,
    previewAllClick,
    publishAllClick,
    bulkMessageIsLoading = false,
    bulkMessageIsSuccess = false,
  } = opts;

  ui.statusEl.textContent = status;
  ui.statusEl.hidden = !String(status || '').trim();
  ui.statusEl.classList.toggle('is-warning', Boolean(String(status || '').trim() && statusIsWarning));
  if (ui.contentCardEl) ui.contentCardEl.hidden = !showContentCard;
  const panel = document.querySelector('.ls-panel');
  if (panel) {
    panel.classList.toggle(
      'ls-minimal',
      Boolean(String(status || '').trim() && !showContentCard),
    );
  }
  ui.langRow.hidden = !showLangRow;
  setCurrentLocale(ui, currentLocale);
  setBulkMessage(ui, bulkMessage, {
    isError: bulkMessageIsError,
    isLoading: bulkMessageIsLoading,
    isSuccess: bulkMessageIsSuccess,
  });

  const showActions = canOpen || showOpenAll;
  ui.actionsEl.hidden = !showActions;
  const panelLoading = document.querySelector('.ls-panel')?.classList.contains('ls-loading');
  if (ui.bulkFooter) {
    ui.bulkFooter.hidden = panelLoading || (!showPreviewAll && !showPublishAll && !bulkMessage);
  }

  ui.openBtn.hidden = !canOpen;
  ui.openBtn.disabled = !canOpen || openDisabled;
  setOpenLabel(ui, openPrimaryLabel);
  ui.openBtn.onclick = () => {
    if (!openUrl) return;
    openUrlsInNewTabs([openUrl]);
  };

  ui.openAllBtn.hidden = !showOpenAll;
  ui.openAllBtn.disabled = false;
  ui.openAllBtn.onclick = showOpenAll && typeof openAllClick === 'function' ? openAllClick : null;

  if (ui.previewAllBtn) {
    ui.previewAllBtn.hidden = !showPreviewAll;
    ui.previewAllBtn.disabled = bulkDisabled;
    ui.previewAllBtn.onclick =
      showPreviewAll && typeof previewAllClick === 'function' ? previewAllClick : null;
  }

  if (ui.publishAllBtn) {
    ui.publishAllBtn.hidden = !showPublishAll;
    ui.publishAllBtn.disabled = bulkDisabled;
    ui.publishAllBtn.onclick =
      showPublishAll && typeof publishAllClick === 'function' ? publishAllClick : null;
  }
}

const LOADING_SPINNER_DELAY_MS = 200;
let panelLoadingDelayTimer = null;

function setPanelLoading(isLoading) {
  const panel = document.querySelector('.ls-panel');
  const compact = document.querySelector('.ls-loading-compact');
  if (!panel) return;
  const loading = Boolean(isLoading);
  panel.classList.toggle('ls-loading', loading);
  panel.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (compact) compact.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function clearPanelLoadingDelay() {
  if (panelLoadingDelayTimer) {
    clearTimeout(panelLoadingDelayTimer);
    panelLoadingDelayTimer = null;
  }
}

/** Avoid a loading flash when placeholders/permissions resolve quickly (e.g. cache hit). */
function startPanelLoadingDeferred() {
  clearPanelLoadingDelay();
  panelLoadingDelayTimer = setTimeout(() => {
    panelLoadingDelayTimer = null;
    setPanelLoading(true);
  }, LOADING_SPINNER_DELAY_MS);
}

function finishPanelLoading() {
  clearPanelLoadingDelay();
  setPanelLoading(false);
}

function setPanelTwoLanguagesMode(isTwo) {
  document.querySelector('.ls-panel')?.classList.toggle('ls-panel-two-languages', Boolean(isTwo));
}

function canonLocale(segment, keys) {
  if (!segment || !keys?.length) return null;
  return keys.find((k) => k.toLowerCase() === segment.toLowerCase()) ?? null;
}

function cachePathKey(sitePath) {
  const s = (sitePath || '').replace(/^\/+|\/+$/g, '').replace(/\//g, '>');
  return s || 'root';
}

async function loadPlaceholderRows(org, repo, branch, tier, sheetName, ttlMs, actions, sitePath) {
  const cacheKey = `ph:${org}:${repo}:${branch}:${tier}:${sheetName}:${cachePathKey(sitePath)}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;
  const { rows } = await fetchLanguageSwitcherRows(
    branch,
    org,
    repo,
    tier,
    sheetName,
    actions,
    sitePath || '',
  );
  writeCache(cacheKey, rows, Number(ttlMs) || 300000);
  return rows;
}

function findLocaleSegmentIndex(segments, langKeys) {
  const set = new Set(langKeys.map((k) => k.toLowerCase()));
  for (let i = 0; i < segments.length; i += 1) {
    if (set.has(segments[i].toLowerCase())) return i;
  }
  return -1;
}

function mergeResolvedSegments(locIndex, segments, resolvedPath) {
  return [...segments.slice(0, locIndex), ...pathnameToSegments(resolvedPath)];
}

let langComboboxOutsideCloseWired = false;
let langMenuResizeListener = null;
let langMenuCloseTimer = null;

const LANG_MENU_TRANSITION_MS = 200;

function initLangCombobox(ui, keys, currentKey, onPickLocale) {
  const others = keys.filter((k) => k.toLowerCase() !== currentKey.toLowerCase());
  const first = others[0];
  if (!first) return;

  if (!ui.langCombobox || !ui.langTrigger || !ui.langMenu) {
    onPickLocale(first);
    return;
  }

  const finishClose = () => {
    langMenuCloseTimer = null;
    ui.langMenu.style.cssText = '';
    if (ui.langMenu.parentNode === document.body) {
      ui.langCombobox.appendChild(ui.langMenu);
    }
    ui.langMenu.setAttribute('aria-hidden', 'true');
  };

  const closeMenu = () => {
    if (langMenuResizeListener) {
      window.removeEventListener('resize', langMenuResizeListener);
      langMenuResizeListener = null;
    }
    ui.langTrigger.setAttribute('aria-expanded', 'false');
    const wasOpen = ui.langMenu.classList.contains('lang-select-menu-open');
    ui.langMenu.classList.remove('lang-select-menu-open');
    clearTimeout(langMenuCloseTimer);
    langMenuCloseTimer = null;
    if (!wasOpen) {
      finishClose();
      return;
    }
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : LANG_MENU_TRANSITION_MS;
    langMenuCloseTimer = setTimeout(finishClose, delay);
  };

  const placeMenuBelowTrigger = () => {
    const r = ui.langTrigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const maxH = Math.max(100, spaceBelow);
    const s = ui.langMenu.style;
    s.position = 'fixed';
    s.left = `${r.left}px`;
    s.width = `${r.width}px`;
    s.top = `${r.bottom}px`;
    s.bottom = 'auto';
    s.right = 'auto';
    s.marginTop = '0';
    s.marginBottom = '0';
    s.maxHeight = `${maxH}px`;
    s.zIndex = '2147483647';
  };

  const openMenu = () => {
    clearTimeout(langMenuCloseTimer);
    langMenuCloseTimer = null;
    ui.langTrigger.setAttribute('aria-expanded', 'true');
    ui.langMenu.setAttribute('aria-hidden', 'false');
    ui.langMenu.scrollTop = 0;
    ui.langMenu.classList.remove('lang-select-menu-open');
    if (ui.langMenu.parentNode !== document.body) {
      document.body.appendChild(ui.langMenu);
    }
    const afterPlace = () => {
      placeMenuBelowTrigger();
      requestAnimationFrame(() => {
        ui.langMenu.classList.add('lang-select-menu-open');
      });
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(afterPlace);
    });
    if (langMenuResizeListener) window.removeEventListener('resize', langMenuResizeListener);
    langMenuResizeListener = placeMenuBelowTrigger;
    window.addEventListener('resize', placeMenuBelowTrigger, { passive: true });
  };

  const setTriggerLabel = (loc) => {
    if (!ui.langValue) return;
    const picked = typeof loc === 'string' && loc.trim();
    ui.langValue.textContent = picked ? formatLocaleDisplay(loc) : LANG_SELECT_PLACEHOLDER;
    ui.langValue.classList.toggle('is-placeholder', !picked);
  };

  ui.langMenu.replaceChildren();
  others.forEach((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lang-select-option';
    b.setAttribute('role', 'option');
    b.textContent = formatLocaleDisplay(k);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      setTriggerLabel(k);
      onPickLocale(k);
    });
    ui.langMenu.appendChild(b);
  });

  const onDocPointerDown = (e) => {
    if (ui.langTrigger.getAttribute('aria-expanded') !== 'true') return;
    const t = e.target;
    if (ui.langCombobox.contains(t) || ui.langMenu.contains(t)) return;
    closeMenu();
  };

  ui.langTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ui.langTrigger.getAttribute('aria-expanded') === 'true') closeMenu();
    else openMenu();
  });

  if (!langComboboxOutsideCloseWired) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        if (ui.langTrigger.getAttribute('aria-expanded') === 'true') closeMenu();
      },
      true,
    );
    langComboboxOutsideCloseWired = true;
  }

  setTriggerLabel(null);
  onPickLocale(null);
}

function buildDest(parsed, org, repo, newSegments, useBranch, tier, target, daView) {
  if (parsed.kind === 'da' || target === 'da-edit') {
    const view = parsed.kind === 'da' ? parsed.view : daView;
    return buildDaHashUrl(view, org, repo, newSegments);
  }
  return buildAemPreviewUrl(useBranch, org, repo, newSegments, tier);
}

function resolvePathWithFallback(rows, fromLoc, toLoc, afterLoc) {
  const fromSheet = resolvePathWithRows(rows, fromLoc, toLoc, afterLoc);
  if (fromSheet) return fromSheet;
  let rest = '';
  if (typeof afterLoc === 'string' && afterLoc.length > 0) {
    rest = afterLoc.startsWith('/') ? afterLoc : `/${afterLoc.replace(/^\//, '')}`;
  }
  return `/${toLoc}${rest}`;
}

function resolveSitePath(contextPath, org, repo, segments) {
  let p = typeof contextPath === 'string' ? contextPath.trim() : '';
  const prefix = `/${org}/${repo}`;
  if (p === prefix || p.startsWith(`${prefix}/`)) {
    p = p.slice(prefix.length);
    if (p && !p.startsWith('/')) p = `/${p}`;
  }
  if (!p && segments.length) p = `/${segments.join('/')}`;
  if (p && !p.startsWith('/')) p = `/${p}`;
  return p;
}

async function resolveToolAccess(actions, aemFetch, org, repo, sitePath) {
  if (typeof actions?.daFetch === 'function') {
    return checkDaContentAccess(actions.daFetch, org, repo, sitePath);
  }
  if (aemFetch) {
    return {
      authenticated: true,
      status: 0,
      permissions: ['read', 'write'],
      canRead: true,
      canWrite: true,
      canPreview: true,
      canPublish: true,
      denied: false,
      message: '',
    };
  }
  return {
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
}

async function main() {
  const { context, actions, token } = await DA_SDK;
  const ui = getUi();
  const aemFetch = createAemFetcher(actions, token);

  const pageUrl = contextToDaUrl({
    org: context.org,
    repo: context.repo || context.site,
    path: context.path,
    view: pickDaView(context),
  });

  if (!pageUrl) {
    setUi(ui, actions, {
      status: 'Missing page context (org, repo, path). Open this tool from the Library while a document page is open.',
    });
    return;
  }

  let uiState = {
    status: '',
    bulkMessage: '',
    bulkMessageIsError: false,
    bulkMessageIsLoading: false,
    bulkMessageIsSuccess: false,
    openUrl: null,
    canOpen: false,
    showLangRow: false,
    showOpenAll: false,
    showPreviewAll: false,
    showPublishAll: false,
    openDisabled: false,
    bulkDisabled: false,
    openPrimaryLabel: PRIMARY_LABEL_WITH_PICKER,
    currentLocale: '',
    openAllClick: null,
    previewAllClick: null,
    publishAllClick: null,
  };

  let bulkMessageDismissTimer = null;

  const bulkCtx = {
    ready: false,
    toolAccess: null,
    targets: [],
    pageListForTargets: () => [],
    lastPreviewByLocale: {},
  };

  const rememberPreviewResults = (results) => {
    bulkCtx.lastPreviewByLocale = {};
    results.forEach((p) => {
      const key = String(p.locale || '').trim().toLowerCase();
      if (key) bulkCtx.lastPreviewByLocale[key] = p;
    });
  };

  const resetBulkMessageFlags = () => ({
    bulkMessageIsError: false,
    bulkMessageIsLoading: false,
    bulkMessageIsSuccess: false,
  });

  const show = (patch = {}) => {
    if (bulkMessageDismissTimer) {
      clearTimeout(bulkMessageDismissTimer);
      bulkMessageDismissTimer = null;
    }
    uiState = { ...uiState, ...patch };
    setUi(ui, actions, uiState);

    const msg = String(uiState.bulkMessage || '').trim();
    if (msg && !uiState.bulkMessageIsLoading && uiState.bulkMessageIsSuccess) {
      bulkMessageDismissTimer = window.setTimeout(() => {
        bulkMessageDismissTimer = null;
        show({
          bulkMessage: '',
          bulkMessageIsError: false,
          bulkMessageIsLoading: false,
          bulkMessageIsSuccess: false,
        });
      }, BULK_MESSAGE_SUCCESS_DISMISS_MS);
    }
  };

  const previewAllClick = async () => {
    if (!bulkCtx.ready) {
      show({
        bulkMessage: 'Still loading…',
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    const { toolAccess } = bulkCtx;
    if (!aemFetch) {
      show({
        bulkMessage: permissionDeniedMessage('preview'),
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    if (!toolAccess?.canRead) {
      show({
        bulkMessage: permissionDeniedMessageForAccess(),
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    if (!toolAccess?.canPreview) {
      show({
        bulkMessage: permissionDeniedMessageForPreview(),
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    const targets = bulkCtx.targets;
    if (!targets.length) {
      show({
        bulkMessage: 'No languages to preview.',
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    show({
      bulkMessage: 'Previewing…',
      ...resetBulkMessageFlags(),
      bulkMessageIsLoading: true,
    });
    try {
      const result = await previewPages(bulkCtx.pageListForTargets(targets), aemFetch);
      rememberPreviewResults(result);
      const ok = result.every((p) => p.status === 200);
      show({
        bulkMessage: summarizeBulkResult(result, 'previewed', 'preview'),
        ...resetBulkMessageFlags(),
        bulkMessageIsSuccess: ok,
        bulkMessageIsError: !ok,
      });
    } catch (e) {
      show({
        bulkMessage: `Preview failed: ${e.message || String(e)}`,
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
    }
  };

  const publishAllClick = async () => {
    if (!bulkCtx.ready) {
      show({
        bulkMessage: 'Still loading…',
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    const { toolAccess } = bulkCtx;
    if (!aemFetch) {
      show({
        bulkMessage: permissionDeniedMessage('publish'),
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    if (!toolAccess?.canRead) {
      show({
        bulkMessage: permissionDeniedMessageForAccess(),
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    if (!toolAccess?.canPublish) {
      show({
        bulkMessage: permissionDeniedMessageForPublish(),
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    const targets = bulkCtx.targets;
    if (!targets.length) {
      show({
        bulkMessage: 'No languages to publish.',
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
      return;
    }
    show({
      bulkMessage: 'Publishing…',
      ...resetBulkMessageFlags(),
      bulkMessageIsLoading: true,
    });
    try {
      const published = await publishPages(bulkCtx.pageListForTargets(targets), aemFetch);
      rememberPreviewResults(
        published.map((p) => ({
          locale: p.locale,
          status: p.previewStatus ?? p.status,
          error: p.error,
        })),
      );
      const ok = published.length > 0 && published.every((p) => p.status === 200);
      show({
        bulkMessage: summarizeBulkResult(published, 'published', 'publish'),
        ...resetBulkMessageFlags(),
        bulkMessageIsSuccess: ok,
        bulkMessageIsError: !ok,
      });
    } catch (e) {
      show({
        bulkMessage: `Publish failed: ${e.message || String(e)}`,
        ...resetBulkMessageFlags(),
        bulkMessageIsError: true,
      });
    }
  };

  const statusOnlyUi = {
    showContentCard: false,
    showLangRow: false,
    showPreviewAll: false,
    showPublishAll: false,
  };

  const finishLoading = (patch = {}) => {
    finishPanelLoading();
    show({
      bulkMessage: '',
      bulkMessageIsLoading: false,
      showPreviewAll: true,
      showPublishAll: true,
      previewAllClick,
      publishAllClick,
      ...patch,
    });
  };

  startPanelLoadingDeferred();
  show({
    status: '',
    bulkMessage: '',
    showContentCard: false,
    showLangRow: false,
    showPreviewAll: false,
    showPublishAll: false,
    ...resetBulkMessageFlags(),
  });

  const parsed = parseCurrentPage(pageUrl);
  if (!parsed) {
    finishLoading({
      status: 'Could not read this page path. Open Language Switcher from a document under org/repo/locale/…',
      statusIsWarning: true,
      ...statusOnlyUi,
    });
    return;
  }

  const { tier, branch, target, daView, placeholderSheetName, placeholderCacheTtlMs } = SETTINGS;
  const { org, repo } = parsed;
  const segments = [...parsed.segments];

  if (!segments.length) {
    finishLoading({
      status: 'This path has no locale folder after org/repo. Open a page such as /en/… or /fr/…',
      statusIsWarning: true,
      ...statusOnlyUi,
    });
    return;
  }

  const useBranch = parsed.kind === 'aem' ? parsed.branch : branch;
  const sitePath = resolveSitePath(context.path, org, repo, segments);

  let rows;
  try {
    rows = await loadPlaceholderRows(
      org,
      repo,
      useBranch,
      tier,
      placeholderSheetName || DEFAULT_SHEET,
      Number(placeholderCacheTtlMs) || 300000,
      actions,
      sitePath,
    );
  } catch (e) {
    finishLoading({
      status: `Could not load placeholders.json (${e.message}).`,
      statusIsWarning: true,
      ...statusOnlyUi,
    });
    return;
  }

  const langKeys = detectLocaleColumnKeys(rows);
  setPanelTwoLanguagesMode(langKeys.length === 2);

  if (!langKeys.length) {
    finishLoading({
      status: 'No language paths in placeholders. Add columns whose values start with / (e.g. en, fr).',
      statusIsWarning: true,
      ...statusOnlyUi,
    });
    return;
  }

  const locIndex = findLocaleSegmentIndex(segments, langKeys);
  if (locIndex < 0) {
    const langs = langKeys.map((k) => `/${k}`).join(', ');
    finishLoading({
      status: `This page is not inside a language folder. Open a document under ${langs} to use Language Mapper.`,
      statusIsWarning: true,
      ...statusOnlyUi,
    });
    return;
  }

  const toolAccess = await resolveToolAccess(actions, aemFetch, org, repo, sitePath);

  const urlSeg = segments[locIndex];
  const afterLoc = pathAfterLocale(segments.slice(locIndex));
  const showLangPicker = langKeys.length >= 3;
  const fromLoc = canonLocale(urlSeg, langKeys);

  const pathCache = new Map();
  const getResolvedPath = (toLoc) => {
    const k = toLoc.toLowerCase();
    if (!pathCache.has(k)) {
      pathCache.set(k, resolvePathWithFallback(rows, fromLoc, toLoc, afterLoc));
    }
    return pathCache.get(k);
  };

  const urlForLocale = (toLoc) => buildDest(
    parsed,
    org,
    repo,
    mergeResolvedSegments(locIndex, segments, getResolvedPath(toLoc)),
    useBranch,
    tier,
    target,
    daView,
  );

  const segmentsForLocale = (toLoc) => mergeResolvedSegments(
    locIndex,
    segments,
    getResolvedPath(toLoc),
  );

  const bulkTargets = () => langKeys;

  const pageListForTargets = (targets) => targets.map((loc) => ({
    locale: loc,
    path: buildAemAdminPath(org, repo, segmentsForLocale(loc)),
  }));

  bulkCtx.ready = true;
  bulkCtx.toolAccess = toolAccess;
  bulkCtx.targets = bulkTargets();
  bulkCtx.pageListForTargets = pageListForTargets;

  show({
    currentLocale: fromLoc || urlSeg,
    showLangRow: showLangPicker,
    showOpenAll: langKeys.length > 2,
    previewAllClick,
    publishAllClick,
    openAllClick: () => {
      const targets = bulkCtx.targets;
      const others = fromLoc
        ? targets.filter((to) => to.toLowerCase() !== fromLoc.toLowerCase())
        : targets;
      const urls = others.map(urlForLocale);
      openUrlsInNewTabs(urls);
    },
  });

  if (langKeys.length === 1) {
    const [only] = langKeys;
    if (urlSeg.toLowerCase() === only.toLowerCase()) {
      show({
        status: `Already on ${only}. Add another language column to map paths, or open a page in a different locale folder.`,
        showLangRow: false,
      });
      return;
    }
    const newSeg = [...segments.slice(0, locIndex), only, ...segments.slice(locIndex + 1)];
    show({
      status: '',
      canOpen: true,
      openUrl: buildDest(parsed, org, repo, newSeg, useBranch, tier, target, daView),
      showLangRow: false,
      openDisabled: false,
      openPrimaryLabel: openPageInLabel(only),
    });
    return;
  }

  if (!fromLoc) {
    show({
      status: `This page’s locale folder is "${urlSeg}" but placeholders only define: ${langKeys.join(', ')}.`,
    });
    return;
  }

  const applyDestination = (toLoc) => {
    if (!toLoc) {
      show({
        status: '',
        canOpen: true,
        openUrl: null,
        openDisabled: true,
        showLangRow: showLangPicker,
        openPrimaryLabel: PRIMARY_LABEL_WITH_PICKER,
      });
      return;
    }
    if (toLoc.toLowerCase() === fromLoc.toLowerCase()) {
      show({
        status: '',
        canOpen: true,
        openUrl: null,
        openDisabled: true,
        showLangRow: showLangPicker,
        openPrimaryLabel: PRIMARY_LABEL_WITH_PICKER,
      });
      return;
    }
    show({
      status: '',
      canOpen: true,
      openUrl: urlForLocale(toLoc),
      openDisabled: false,
      showLangRow: showLangPicker,
      openPrimaryLabel: showLangPicker
        ? PRIMARY_LABEL_WITH_PICKER
        : openPageInLabel(toLoc),
    });
  };

  finishLoading({ status: '' });

  if (showLangPicker) {
    initLangCombobox(ui, langKeys, fromLoc, applyDestination);
  } else {
    applyDestination(langKeys.find((k) => k.toLowerCase() !== fromLoc.toLowerCase()));
  }
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('status');
  if (el) {
    el.textContent = `Error: ${err.message || String(err)}`;
    el.hidden = false;
  }
});
