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
  liveUrlsFromPages,
  summarizeBulkResult,
} from './aem-admin.js';

const PRIMARY_LABEL_WITH_PICKER = 'Open page for selected language';
const BULK_MESSAGE_DISMISS_MS = 3000;

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

function scheduleCloseLibrary(actions) {
  if (typeof actions?.closeLibrary === 'function') window.setTimeout(() => actions.closeLibrary(), 300);
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
    bulkMessage = '',
    bulkMessageIsError = false,
    openUrl = null,
    canOpen = false,
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
  ui.langRow.hidden = !showLangRow;
  setCurrentLocale(ui, currentLocale);
  setBulkMessage(ui, bulkMessage, {
    isError: bulkMessageIsError,
    isLoading: bulkMessageIsLoading,
    isSuccess: bulkMessageIsSuccess,
  });

  const showActions = canOpen || showOpenAll;
  ui.actionsEl.hidden = !showActions;
  if (ui.bulkFooter) ui.bulkFooter.hidden = !showPreviewAll && !showPublishAll;

  ui.openBtn.hidden = !canOpen;
  ui.openBtn.disabled = !canOpen || openDisabled;
  setOpenLabel(ui, openPrimaryLabel);
  ui.openBtn.onclick = () => {
    if (!openUrl) return;
    openUrlsInNewTabs([openUrl]);
    scheduleCloseLibrary(actions);
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

function setPanelLoading(isLoading) {
  document.querySelector('.ls-panel')?.classList.toggle('ls-loading', Boolean(isLoading));
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
    const gap = 4;
    const spaceBelow = window.innerHeight - r.bottom - gap - 8;
    const maxH = Math.max(100, spaceBelow);
    const s = ui.langMenu.style;
    s.position = 'fixed';
    s.left = `${r.left}px`;
    s.width = `${r.width}px`;
    s.top = `${r.bottom + gap}px`;
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
    if (ui.langValue) ui.langValue.textContent = formatLocaleDisplay(loc);
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

  setTriggerLabel(first);
  onPickLocale(first);
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

function publishResultMessage(published) {
  const liveUrls = liveUrlsFromPages(published);
  if (!published?.length) return { text: '', isError: false };
  if (!liveUrls.length) {
    return { text: 'No pages published.', isError: true };
  }
  const n = liveUrls.length;
  return { text: `${n} page(s) published.`, isError: false };
}

async function main() {
  const { context, actions, token } = await DA_SDK;
  const ui = getUi();
  setPanelLoading(true);
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
    showPreviewAll: true,
    showPublishAll: true,
    openDisabled: false,
    bulkDisabled: false,
    openPrimaryLabel: PRIMARY_LABEL_WITH_PICKER,
    currentLocale: '',
    openAllClick: null,
    previewAllClick: null,
    publishAllClick: null,
  };

  let bulkMessageDismissTimer = null;

  const show = (patch = {}) => {
    if (bulkMessageDismissTimer) {
      clearTimeout(bulkMessageDismissTimer);
      bulkMessageDismissTimer = null;
    }
    uiState = { ...uiState, ...patch };
    setUi(ui, actions, uiState);

    const msg = String(uiState.bulkMessage || '').trim();
    if (msg && !uiState.bulkMessageIsLoading) {
      bulkMessageDismissTimer = window.setTimeout(() => {
        bulkMessageDismissTimer = null;
        show({
          bulkMessage: '',
          bulkMessageIsError: false,
          bulkMessageIsLoading: false,
          bulkMessageIsSuccess: false,
        });
      }, BULK_MESSAGE_DISMISS_MS);
    }
  };

  show({
    status: '',
    bulkMessage: 'Loading placeholders…',
    bulkMessageIsLoading: true,
    showLangRow: false,
  });

  const finishLoading = (patch = {}) => {
    setPanelLoading(false);
    show({
      bulkMessage: '',
      bulkMessageIsLoading: false,
      ...patch,
    });
  };

  const parsed = parseCurrentPage(pageUrl);
  if (!parsed) {
    finishLoading({ status: 'Could not parse this page (need /org/repo/locale/… in context.path).' });
    return;
  }

  const { tier, branch, target, daView, placeholderSheetName, placeholderCacheTtlMs } = SETTINGS;
  const { org, repo } = parsed;
  const segments = [...parsed.segments];

  if (!segments.length) {
    finishLoading({ status: 'Path must include a locale folder after org/repo.' });
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
    finishLoading({ status: `Could not load placeholders.json (${e.message}).` });
    return;
  }

  const langKeys = detectLocaleColumnKeys(rows);
  setPanelTwoLanguagesMode(langKeys.length === 2);

  if (!langKeys.length) {
    finishLoading({
      status: 'No path columns found in language-switcher (values should start with /, e.g. en, fr).',
    });
    return;
  }

  const locIndex = findLocaleSegmentIndex(segments, langKeys);
  if (locIndex < 0) {
    finishLoading({
      status: `No folder in this path matches a language column (${langKeys.join(', ')}).`,
    });
    return;
  }

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
    path: buildAemAdminPath(org, repo, segmentsForLocale(loc)),
  }));

  const resetBulkMessageFlags = () => ({
    bulkMessageIsError: false,
    bulkMessageIsLoading: false,
    bulkMessageIsSuccess: false,
  });

  const wireBulkActions = () => {
    const targets = bulkTargets();
    show({
      currentLocale: fromLoc || urlSeg,
      showLangRow: showLangPicker,
      showOpenAll: langKeys.length > 2,
      showPreviewAll: true,
      showPublishAll: true,
      openAllClick: () => {
        const others = fromLoc
          ? targets.filter((to) => to.toLowerCase() !== fromLoc.toLowerCase())
          : targets;
        const urls = others.map(urlForLocale);
        openUrlsInNewTabs(urls);
        if (urls.length) scheduleCloseLibrary(actions);
      },
      previewAllClick: async () => {
        if (!aemFetch) {
          show({
            bulkMessage: 'Preview requires DA authentication. Open this tool from DA while signed in.',
            ...resetBulkMessageFlags(),
            bulkMessageIsError: true,
          });
          return;
        }
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
          const result = await previewPages(pageListForTargets(targets), aemFetch);
          const ok = result.every((p) => p.status === 200);
          show({
            bulkMessage: summarizeBulkResult(result, 'previewed'),
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
      },
      publishAllClick: async () => {
        if (!aemFetch) {
          show({
            bulkMessage: 'Publishing requires DA authentication. Open this tool from DA while signed in.',
            ...resetBulkMessageFlags(),
            bulkMessageIsError: true,
          });
          return;
        }
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
          const published = await publishPages(pageListForTargets(targets), aemFetch);
          const { text, isError } = publishResultMessage(published);
          const ok = !isError && published.some((p) => p.status === 200);
          show({
            bulkMessage: text || summarizeBulkResult(published, 'published'),
            ...resetBulkMessageFlags(),
            bulkMessageIsSuccess: ok,
            bulkMessageIsError: isError || !ok,
          });
        } catch (e) {
          show({
            bulkMessage: `Publish failed: ${e.message || String(e)}`,
            ...resetBulkMessageFlags(),
            bulkMessageIsError: true,
          });
        }
      },
    });
  };

  wireBulkActions();

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
