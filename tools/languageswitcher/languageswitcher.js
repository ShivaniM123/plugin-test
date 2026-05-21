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
  publishDeniedHoverHint,
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

const trimmed = (value) => String(value ?? '').trim();

const AEM_FALLBACK_ACCESS = {
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

const NO_DA_ACCESS = {
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

let cachedPanel = null;

function getPanel() {
  if (!cachedPanel) cachedPanel = document.querySelector('.ls-panel');
  return cachedPanel;
}

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
  const msg = trimmed(text);
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

function wireBulkBtn(btn, { hidden, disabled, title, onClick }) {
  if (!btn) return;
  btn.hidden = hidden;
  btn.disabled = disabled;
  btn.title = title;
  btn.onclick = onClick;
}

function setUi(ui, opts = {}) {
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
    toolAccess = null,
    hasAemFetch = false,
  } = opts;

  const statusText = trimmed(status);
  const statusVisible = Boolean(statusText);
  ui.statusEl.textContent = status;
  ui.statusEl.hidden = !statusVisible;
  ui.statusEl.classList.toggle('is-warning', statusVisible && statusIsWarning);
  if (ui.contentCardEl) ui.contentCardEl.hidden = !showContentCard;
  const panel = getPanel();
  const panelLoading = panel?.classList.contains('ls-loading');
  if (panel) {
    const statusOnly = statusVisible && !showContentCard;
    panel.classList.toggle('ls-minimal', statusOnly);
    panel.classList.toggle('ls-pending', !showContentCard && !statusVisible && !panelLoading);
  }
  ui.langRow.hidden = !showLangRow;
  setCurrentLocale(ui, currentLocale);
  setBulkMessage(ui, bulkMessage, {
    isError: bulkMessageIsError,
    isLoading: bulkMessageIsLoading,
    isSuccess: bulkMessageIsSuccess,
  });

  if (ui.bulkFooter) {
    ui.bulkFooter.hidden = panelLoading
      || !showContentCard
      || (!showPreviewAll && !showPublishAll && !bulkMessage);
  }

  ui.actionsEl.hidden = !showContentCard;
  ui.openBtn.hidden = !showContentCard;
  ui.openBtn.disabled = !showContentCard || !canOpen || openDisabled;
  setOpenLabel(ui, openPrimaryLabel);
  ui.openBtn.onclick = () => {
    if (!openUrl) return;
    openUrlsInNewTabs([openUrl]);
  };

  ui.openAllBtn.hidden = !showOpenAll;
  ui.openAllBtn.disabled = false;
  ui.openAllBtn.onclick = showOpenAll && typeof openAllClick === 'function' ? openAllClick : null;

  const previewAllowed = !bulkDisabled && hasAemFetch && Boolean(toolAccess?.canPreview);
  const publishAllowed = !bulkDisabled && hasAemFetch && Boolean(toolAccess?.canPublish);

  wireBulkBtn(ui.previewAllBtn, {
    hidden: !showPreviewAll,
    disabled: !previewAllowed,
    title: previewAllowed ? '' : permissionDeniedMessageForPreview(),
    onClick: previewAllowed && typeof previewAllClick === 'function' ? previewAllClick : null,
  });
  wireBulkBtn(ui.publishAllBtn, {
    hidden: !showPublishAll,
    disabled: !publishAllowed,
    title: publishAllowed ? '' : publishDeniedHoverHint(),
    onClick: publishAllowed && typeof publishAllClick === 'function' ? publishAllClick : null,
  });
}

function setPanelLoading(isLoading) {
  const panel = getPanel();
  const compact = document.querySelector('.ls-loading-compact');
  if (!panel) return;
  const loading = Boolean(isLoading);
  panel.classList.toggle('ls-loading', loading);
  if (loading) panel.classList.remove('ls-pending');
  panel.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (compact) compact.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function finishPanelLoading() {
  setPanelLoading(false);
}

function setPanelTwoLanguagesMode(isTwo) {
  getPanel()?.classList.toggle('ls-panel-two-languages', Boolean(isTwo));
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
  const locales = new Set(langKeys.map((k) => k.toLowerCase()));
  return segments.findIndex((seg) => locales.has(seg.toLowerCase()));
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
  if (aemFetch) return AEM_FALLBACK_ACCESS;
  return NO_DA_ACCESS;
}

async function main() {
  setPanelLoading(true);
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
    setUi(ui, {
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
    hasAemFetch: Boolean(aemFetch),
    targets: [],
    pageListForTargets: () => [],
    lastPreviewByLocale: {},
  };

  const rememberPreviewResults = (results) => {
    bulkCtx.lastPreviewByLocale = Object.fromEntries(
      results
        .map((p) => [trimmed(p.locale).toLowerCase(), p])
        .filter(([key]) => key),
    );
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
    setUi(ui, uiState);

    const msg = trimmed(uiState.bulkMessage);
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

  const showBulkError = (bulkMessage) => {
    show({ bulkMessage, ...resetBulkMessageFlags(), bulkMessageIsError: true });
  };

  const statusOnlyUi = {
    showContentCard: false,
    showLangRow: false,
    showPreviewAll: false,
    showPublishAll: false,
  };

  const bulkPreconditionError = (toolAccess, action) => {
    if (!bulkCtx.ready) return 'Still loading…';
    if (!aemFetch) return permissionDeniedMessage(action);
    if (!toolAccess?.canRead) return permissionDeniedMessageForAccess();
    if (action === 'preview' && !toolAccess?.canPreview) return permissionDeniedMessageForPreview();
    if (action === 'publish' && !toolAccess?.canPublish) return permissionDeniedMessageForPublish();
    if (!bulkCtx.targets.length) {
      return action === 'preview' ? 'No languages to preview.' : 'No languages to publish.';
    }
    return null;
  };

  const runBulkAction = async ({
    action,
    loadingMessage,
    failLabel,
    summarizeLabel,
    run,
    mapResults,
  }) => {
    const err = bulkPreconditionError(bulkCtx.toolAccess, action);
    if (err) {
      showBulkError(err);
      return;
    }
    show({ bulkMessage: loadingMessage, ...resetBulkMessageFlags(), bulkMessageIsLoading: true });
    try {
      const result = await run(bulkCtx.targets);
      if (mapResults) rememberPreviewResults(mapResults(result));
      const ok = action === 'publish'
        ? result.length > 0 && result.every((p) => p.status === 200)
        : result.every((p) => p.status === 200);
      show({
        bulkMessage: summarizeBulkResult(result, summarizeLabel, action),
        ...resetBulkMessageFlags(),
        bulkMessageIsSuccess: ok,
        bulkMessageIsError: !ok,
      });
    } catch (e) {
      showBulkError(`${failLabel} failed: ${e.message || String(e)}`);
    }
  };

  const previewAllClick = () => runBulkAction({
    action: 'preview',
    loadingMessage: 'Previewing…',
    failLabel: 'Preview',
    summarizeLabel: 'previewed',
    run: (targets) => previewPages(bulkCtx.pageListForTargets(targets), aemFetch),
    mapResults: (result) => result,
  });

  const publishAllClick = () => runBulkAction({
    action: 'publish',
    loadingMessage: 'Publishing…',
    failLabel: 'Publish',
    summarizeLabel: 'published',
    run: (targets) => publishPages(bulkCtx.pageListForTargets(targets), aemFetch),
    mapResults: (published) => published.map((p) => ({
      locale: p.locale,
      status: p.previewStatus ?? p.status,
      error: p.error,
    })),
  });

  const readyUi = (toolAccess) => ({
    showContentCard: true,
    showPreviewAll: true,
    showPublishAll: true,
    bulkDisabled: false,
    hasAemFetch: Boolean(aemFetch),
    toolAccess,
    previewAllClick,
    publishAllClick,
  });

  const finishLoading = (patch = {}) => {
    finishPanelLoading();
    const access = patch.toolAccess ?? bulkCtx.toolAccess;
    show({
      bulkMessage: '',
      bulkMessageIsLoading: false,
      ...readyUi(access),
      ...patch,
    });
  };

  const finishWithWarning = (status) => {
    finishLoading({ status, statusIsWarning: true, ...statusOnlyUi });
  };

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
    finishWithWarning(
      'Could not read this page path. Open Language Switcher from a document under org/repo/locale/…',
    );
    return;
  }

  const { tier, branch, target, daView, placeholderSheetName, placeholderCacheTtlMs } = SETTINGS;
  const { org, repo } = parsed;
  const segments = [...parsed.segments];

  if (!segments.length) {
    finishWithWarning(
      'This path has no locale folder after org/repo. Open a page such as /en/… or /fr/…',
    );
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
    finishWithWarning(String(e?.message || e || 'Could not find placeholders.json.'));
    return;
  }

  const langKeys = detectLocaleColumnKeys(rows);
  setPanelTwoLanguagesMode(langKeys.length === 2);
  const sheetLabel = placeholderSheetName || DEFAULT_SHEET;

  if (!langKeys.length) {
    finishWithWarning(
      `Could not find language paths in the "${sheetLabel}" sheet. Add columns (e.g. en, fr) whose values start with /.`,
    );
    return;
  }

  const locIndex = findLocaleSegmentIndex(segments, langKeys);
  if (locIndex < 0) {
    finishWithWarning(
      `This page is not inside a language folder. Open a document under ${langKeys.map((k) => `/${k}`).join(', ')} to use Language Mapper.`,
    );
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
    if (!pathCache.has(k)) pathCache.set(k, resolvePathWithFallback(rows, fromLoc, toLoc, afterLoc));
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

  const pageListForTargets = (targets) => targets.map((loc) => ({
    locale: loc,
    path: buildAemAdminPath(org, repo, segmentsForLocale(loc)),
  }));

  bulkCtx.ready = true;
  bulkCtx.toolAccess = toolAccess;
  bulkCtx.targets = langKeys;
  bulkCtx.pageListForTargets = pageListForTargets;

  const openAllClickHandler = () => {
    const targets = bulkCtx.targets;
    const others = fromLoc
      ? targets.filter((to) => to.toLowerCase() !== fromLoc.toLowerCase())
      : targets;
    const urls = others.map(urlForLocale);
    openUrlsInNewTabs(urls);
  };

  if (langKeys.length === 1) {
    const [only] = langKeys;
    if (urlSeg.toLowerCase() === only.toLowerCase()) {
      finishLoading({
        status: `Already on ${only}. Add another language column to map paths, or open a page in a different locale folder.`,
        showLangRow: false,
        canOpen: false,
      });
      return;
    }
    const newSeg = [...segments.slice(0, locIndex), only, ...segments.slice(locIndex + 1)];
    finishLoading({
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
    finishLoading({
      status: `This page’s locale folder is "${urlSeg}" but placeholders only define: ${langKeys.join(', ')}.`,
      showLangRow: false,
      canOpen: false,
    });
    return;
  }

  const showOpenState = ({ openUrl, openDisabled, openPrimaryLabel }) => {
    show({
      status: '',
      canOpen: true,
      openUrl,
      openDisabled,
      showLangRow: showLangPicker,
      openPrimaryLabel: openPrimaryLabel ?? PRIMARY_LABEL_WITH_PICKER,
    });
  };

  const applyDestination = (toLoc) => {
    if (!toLoc || toLoc.toLowerCase() === fromLoc.toLowerCase()) {
      showOpenState({ openUrl: null, openDisabled: true });
      return;
    }
    showOpenState({
      openUrl: urlForLocale(toLoc),
      openDisabled: false,
      openPrimaryLabel: showLangPicker ? PRIMARY_LABEL_WITH_PICKER : openPageInLabel(toLoc),
    });
  };

  finishLoading({
    status: '',
    currentLocale: fromLoc || urlSeg,
    showLangRow: showLangPicker,
    showOpenAll: langKeys.length > 2,
    openAllClick: openAllClickHandler,
    canOpen: true,
    openDisabled: Boolean(showLangPicker),
  });

  if (showLangPicker) {
    initLangCombobox(ui, langKeys, fromLoc, applyDestination);
  } else {
    applyDestination(langKeys.find((k) => k.toLowerCase() !== fromLoc.toLowerCase()));
  }
}

main().catch((err) => {
  console.error(err);
  finishPanelLoading();
  getPanel()?.classList.remove('ls-pending');
  const el = document.getElementById('status');
  if (el) {
    el.textContent = `Error: ${err.message || String(err)}`;
    el.hidden = false;
    el.classList.add('is-warning');
  }
});
