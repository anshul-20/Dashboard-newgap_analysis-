/**
 * shared.js — Central data layer for the dashboard.
 *
 * DATA FLOW:
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. IndexedDB CACHE
 *       → Persists across page refreshes, tab closes, and browser restarts.
 *       → The UI ALWAYS reads from this cache. Page loads NEVER hit the API.
 *
 *  2. BACKGROUND POLLER (independent of UI)
 *       → A setInterval fires every 30 minutes (configurable via config.js).
 *       → When it fires, it fetches fresh data from the API (or fallback),
 *         normalizes it, and writes it to IndexedDB.
 *       → The poller runs completely independently of page navigation or
 *         user-triggered refreshes.
 *       → Cross-tab coordination: only ONE tab runs the poller at a time
 *         (via a localStorage lock). Other tabs read the shared cache.
 *
 *  3. INITIAL SEED
 *       → On the very first visit (empty IndexedDB), the UI triggers a
 *         one-time synchronous API fetch to seed the cache. All subsequent
 *         page loads read from the cache.
 *
 *  4. FALLBACK FILE  (config.js → fallbackDataUrl, e.g. response.txt)
 *       → Used only when the live API fails during the initial seed or
 *         during a background refresh.
 *
 *  5. ERROR STATE
 *       → Shown only on the very first visit when BOTH API and fallback fail
 *         and the cache is empty. Once data is cached, errors during background
 *         refreshes are silently logged — the UI continues showing stale data.
 *
 * KEY BEHAVIOUR:
 * ─────────────────────────────────────────────────────────────────────────────
 *  • Page refresh → reads from IndexedDB → instant render, NO API hit.
 *  • New tab → reads from shared IndexedDB → instant render, NO API hit.
 *  • Every 30 minutes → background poller hits API → updates IndexedDB.
 *  • Multiple tabs → only one poller runs; all tabs share the same cache.
 *
 * HOW TO CHANGE THINGS LATER:
 * ─────────────────────────────────────────────────────────────────────────────
 *  • Refresh interval    → config.js : refreshIntervalMs  (ms)
 *  • API endpoint        → config.js : apiUrl
 *  • Fallback file path  → config.js : fallbackDataUrl
 *  • Debug logging       → config.js : debug  (true / false)
 *  • Request timeout     → FETCH_TIMEOUT_MS constant below
 *  • Cache DB name       → IDB_DB_NAME constant below
 */

import { APP_CONFIG } from "./config.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const GET_API_URL = String(APP_CONFIG.apiUrl || "").trim();
const FALLBACK_DATA_URL = String(APP_CONFIG.fallbackDataUrl || "").trim();

/**
 * DEBUG — When true:
 *   • Full error messages are shown in the UI.
 *   • Every cache / fetch event is logged to the browser console.
 * Set via config.js → debug: true/false.
 * NEVER set to true in production.
 */
const DEBUG = Boolean(APP_CONFIG.debug);

/**
 * FETCH_TIMEOUT_MS — How long (ms) to wait for a single HTTP request before
 * giving up and trying the next candidate (API → fallback).
 * Default: 15 000 ms (15 s). Increase if your API is consistently slow.
 * Decrease if you want faster failover to the fallback file.
 */
const FETCH_TIMEOUT_MS = 25_000;

/**
 * IDB_DB_NAME / IDB_STORE_NAME — IndexedDB database and object store names.
 * IndexedDB is used instead of localStorage because:
 *   • It handles hundreds of MB (localStorage caps at 5-10 MB).
 *   • It is fully async (no main-thread blocking on large writes).
 *   • It stores structured JS objects (no JSON.stringify/parse overhead).
 *   • It is harder to tamper with via browser DevTools.
 */
const IDB_DB_NAME = "dashboard_db";
const IDB_STORE_NAME = "cache";
const IDB_CACHE_KEY = "dashboard_data";

/**
 * POLLER_LOCK_KEY — localStorage key used to coordinate background polling
 * across multiple browser tabs. Only the tab that holds this lock runs the
 * setInterval poller. Other tabs are passive readers.
 */
const POLLER_LOCK_KEY = "dashboard_poller_lock";

/**
 * POLLER_LOCK_TTL_MS — If a poller lock is older than this, it is considered
 * stale (the tab that created it probably closed). Another tab can then
 * take over. Set to 2× the refresh interval so normal operation never
 * triggers a false takeover.
 */
const POLLER_LOCK_TTL_MS = 2 * (Number(APP_CONFIG.refreshIntervalMs) || 30 * 60 * 1000);

// ─── Auto-refresh interval ────────────────────────────────────────────────────

export const AUTO_REFRESH_MS = normalizeRefreshInterval(APP_CONFIG.refreshIntervalMs);
export const AUTO_REFRESH_LABEL = formatRefreshInterval(AUTO_REFRESH_MS);

// ─── In-memory cache (fast path within the same page) ────────────────────────
//
// This is the L1 cache. It avoids repeated IndexedDB reads within a single
// page session. It's wiped on page navigation because the JS module is
// re-evaluated, but IndexedDB (L2) survives.

const _mem = {
  data: null,       // last normalizePayload() result
  fetchedAt: 0,     // Date.now() timestamp of the last successful fetch
};

// In-flight lock — prevents duplicate API requests when multiple callers
// invoke fetchDashboardData() simultaneously on the same page.
let _inFlight = null;

// ─── IndexedDB cache helpers ─────────────────────────────────────────────────

/**
 * _openDB() — Opens (or creates) the IndexedDB database.
 * Returns a Promise that resolves to the IDBDatabase instance.
 * The database is created on first use with a single object store.
 */
function _openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * readCache() — Reads the cached data from IndexedDB.
 * Returns a Promise that resolves to { data, fetchedAt } or null.
 *
 * IndexedDB advantages over localStorage:
 *   • Handles hundreds of MB (vs 5-10 MB limit).
 *   • Fully async — never blocks the main thread.
 *   • Stores structured JS objects (no JSON.stringify/parse overhead).
 *   • Shared across all tabs on the same origin.
 */
async function readCache() {
  try {
    const db = await _openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE_NAME, "readonly");
      const store = tx.objectStore(IDB_STORE_NAME);
      const request = store.get(IDB_CACHE_KEY);
      request.onsuccess = () => {
        const result = request.result;
        if (result && result.data && result.fetchedAt) {
          resolve(result); // { data, fetchedAt }
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * writeCache() — Writes { data, fetchedAt } to IndexedDB.
 * Returns a Promise. Silently ignores errors so a storage failure
 * never breaks the dashboard.
 */
async function writeCache(data) {
  try {
    const db = await _openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_STORE_NAME);
      store.put({ data, fetchedAt: Date.now() }, IDB_CACHE_KEY);
      tx.oncomplete = () => {
        if (DEBUG) console.log("[Cache] Written to IndexedDB at", new Date().toLocaleTimeString());
        resolve();
      };
      tx.onerror = () => {
        if (DEBUG) console.warn("[Cache] IndexedDB write failed.");
        resolve();
      };
    });
  } catch {
    if (DEBUG) console.warn("[Cache] IndexedDB write failed (db open error).");
  }
}

/**
 * clearCache()
 *
 * Removes both the in-memory and IndexedDB cache entries.
 * Call this to force a fresh API hit on the next fetchDashboardData() call.
 *
 * Usage example (manual refresh button):
 *   import { clearCache, fetchDashboardData } from "./shared.js";
 *   clearCache();
 *   const data = await fetchDashboardData();
 */
export async function clearCache() {
  _mem.data = null;
  _mem.fetchedAt = 0;
  try {
    const db = await _openDB();
    const tx = db.transaction(IDB_STORE_NAME, "readwrite");
    tx.objectStore(IDB_STORE_NAME).delete(IDB_CACHE_KEY);
  } catch { /* ignore */ }
  if (DEBUG) console.log("[Cache] Manually cleared — next call will hit the network.");
}

// ─── Background Poller (Independent of UI) ────────────────────────────────────

/**
 * _backgroundRefresh()
 *
 * Called by the background poller every AUTO_REFRESH_MS.
 * Fetches fresh data from the API (or fallback), normalizes it, and writes
 * it to localStorage. This runs silently — errors are logged but NEVER
 * shown to the user or thrown to the UI. The UI continues showing the
 * previously cached data until refreshed.
 */
async function _backgroundRefresh() {
  if (DEBUG) console.log("[Poller] Background refresh triggered at", new Date().toLocaleTimeString());

  try {
    const payload = await fetchPayload();
    const normalized = safeNormalize(payload);

    // Update both cache layers
    _mem.data = normalized;
    _mem.fetchedAt = Date.now();
    await writeCache(normalized);

    // Refresh the poller lock heartbeat
    _writePollerLock();

    if (DEBUG) {
      console.log(
        `[Poller] Success — ${normalized.topics.length} topics stored.`,
        `Next refresh in ${Math.round(AUTO_REFRESH_MS / 1000)}s`
      );
    }
  } catch (error) {
    // SILENT failure — the UI keeps showing stale cached data.
    // This is intentional: a transient API outage should NOT break the dashboard.
    if (DEBUG) console.warn("[Poller] Background refresh failed →", error.message);
  }
}

/**
 * _writePollerLock() — Claims or refreshes the background poller lock.
 */
function _writePollerLock() {
  try {
    localStorage.setItem(POLLER_LOCK_KEY, JSON.stringify({
      tabId: _tabId,
      timestamp: Date.now(),
    }));
  } catch { /* ignore */ }
}

/**
 * _isPollerLockFree() — Returns true if no other tab currently owns the lock.
 */
function _isPollerLockFree() {
  try {
    const raw = localStorage.getItem(POLLER_LOCK_KEY);
    if (!raw) return true;
    const lock = JSON.parse(raw);
    // If we own the lock, it's "free" for us
    if (lock.tabId === _tabId) return true;
    // If the lock is stale (the other tab probably closed), take over
    if (Date.now() - lock.timestamp > POLLER_LOCK_TTL_MS) return true;
    return false;
  } catch {
    return true;
  }
}

// Unique ID for this tab instance (to coordinate the poller lock)
const _tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// BroadcastChannel for cross-tab cache sync.
// IndexedDB does not fire `storage` events like localStorage, so when the
// poller tab writes fresh data, it sends a "cache_updated" message via this
// channel. Passive tabs listen for this message and reload from IndexedDB.
const _broadcastChannel = new BroadcastChannel("dashboard_cache_sync");

// ─── Main data-fetch entry point ──────────────────────────────────────────────

/**
 * fetchDashboardData()
 *
 * Returns a normalised dashboard payload. The UI calls this on every page load.
 *
 * Behaviour:
 *   1. Check L1 (in-memory) — instant, sub-millisecond.
 *   2. Check L2 (IndexedDB) — survives refreshes, shared across tabs.
 *   3. If BOTH are empty (first-ever visit), do a ONE-TIME synchronous API
 *      fetch to seed the cache. All subsequent calls read from cache.
 *
 * Page refreshes NEVER hit the API. The background poller (started by
 * startBackgroundPoller()) handles all API communication.
 */
export async function fetchDashboardData() {
  // ── L1: In-memory cache ───────────────────────────────────────────────────
  if (_mem.data !== null) {
    if (DEBUG) {
      const age = Math.round((Date.now() - _mem.fetchedAt) / 1000);
      console.log(`[Cache L1] HIT (in-memory) — age ${age}s`);
    }
    return _mem.data;
  }

  // ── L2: IndexedDB (persists across refreshes and tabs) ────────────────────
  const stored = await readCache();
  if (stored && stored.data) {
    if (DEBUG) {
      const age = Math.round((Date.now() - stored.fetchedAt) / 1000);
      console.log(`[Cache L2] HIT (IndexedDB) — age ${age}s`);
    }
    // Promote to L1 so subsequent in-page calls skip IndexedDB reads
    _mem.data = stored.data;
    _mem.fetchedAt = stored.fetchedAt;
    return stored.data;
  }

  // ── INITIAL SEED: First-ever visit, cache is completely empty ─────────────
  if (DEBUG) console.log("[Cache] COLD — no cached data found, performing initial seed…");

  // Dedup: reuse an already-in-flight request
  if (_inFlight) {
    if (DEBUG) console.log("[Cache] IN-FLIGHT — reusing existing request…");
    return _inFlight;
  }

  _inFlight = (async () => {
    try {
      const payload = await fetchPayload();
      const normalized = safeNormalize(payload);

      // Write to both cache layers
      _mem.data = normalized;
      _mem.fetchedAt = Date.now();
      await writeCache(normalized);

      if (DEBUG) {
        console.log(
          `[Cache] Initial seed complete — ${normalized.topics.length} topics.`,
          `Background poller will refresh every ${Math.round(AUTO_REFRESH_MS / 1000)}s`
        );
      }

      return normalized;
    } finally {
      _inFlight = null;
    }
  })();

  return _inFlight;
}

// ─── Public: Start the background poller ──────────────────────────────────────

/**
 * startBackgroundPoller()
 *
 * Starts the independent background refresh timer. Call this ONCE per page
 * (typically in the DOMContentLoaded handler of each page script).
 *
 * Behaviour:
 *   • Only ONE tab runs the poller at any time (coordinated via localStorage lock).
 *   • The poller fires every AUTO_REFRESH_MS (default: 30 minutes).
 *   • It fetches the API, normalizes the data, and writes to IndexedDB.
 *   • Errors are silently logged — the UI is never interrupted.
 *   • If the tab that owns the poller closes, another tab will take over
 *     after POLLER_LOCK_TTL_MS expires.
 *
 * REPLACES the old setupAutoRefresh() function.
 */
export function startBackgroundPoller() {
  if (window.__dashboardPollerActive) return;
  window.__dashboardPollerActive = true;

  // Try to claim the poller lock
  if (_isPollerLockFree()) {
    _writePollerLock();
    if (DEBUG) console.log(`[Poller] This tab (${_tabId}) claimed the poller lock.`);

    // Start the independent timer
    window.setInterval(async () => {
      // Re-check lock ownership (another tab may have taken over)
      if (!_isPollerLockFree()) {
        if (DEBUG) console.log("[Poller] Lock lost to another tab, skipping this cycle.");
        return;
      }
      _writePollerLock(); // refresh heartbeat
      await _backgroundRefresh();

      // Notify other tabs that the cache has been updated
      try { _broadcastChannel.postMessage("cache_updated"); } catch { /* ignore */ }
    }, AUTO_REFRESH_MS);
  } else {
    if (DEBUG) console.log("[Poller] Another tab owns the poller lock. This tab is a passive reader.");
  }

  // Listen for cache updates from OTHER tabs via BroadcastChannel.
  // IndexedDB does not fire storage events like localStorage, so we use
  // BroadcastChannel to notify passive tabs when the poller tab writes new data.
  _broadcastChannel.onmessage = async (event) => {
    if (event.data === "cache_updated") {
      if (DEBUG) console.log("[Cache] Another tab updated IndexedDB — refreshing in-memory data.");
      const stored = await readCache();
      if (stored && stored.data) {
        _mem.data = stored.data;
        _mem.fetchedAt = stored.fetchedAt;
      }
    }
  };
}

/**
 * setupAutoRefresh()
 *
 * DEPRECATED — kept for backward compatibility.
 * Now delegates to startBackgroundPoller().
 */
export function setupAutoRefresh() {
  startBackgroundPoller();
}

// ─── Network layer ────────────────────────────────────────────────────────────

/**
 * fetchPayload()
 *
 * Tries each URL in [API, fallback] order.
 * Moves to the next candidate when:
 *   • Network / CORS error
 *   • HTTP status is not 2xx
 *   • Response JSON has an empty topics array
 *   • Request exceeds FETCH_TIMEOUT_MS
 *
 * Throws the last error only when all candidates are exhausted.
 */
async function fetchPayload() {
  const candidates = [GET_API_URL, FALLBACK_DATA_URL].filter(Boolean);

  if (!candidates.length) {
    throw new Error(
      "No data source configured. Set apiUrl or fallbackDataUrl in config.js."
    );
  }

  let lastError = null;

  for (const url of candidates) {
    try {
      if (DEBUG) console.log(`[Fetch] Trying: ${url}`);

      const response = await fetch(withCacheBust(url), {
        headers: { Accept: "application/json" },
        cache: "no-store",
        mode: "cors",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      const json = await response.json();

      const rawTopics = Array.isArray(json)
        ? json
        : Array.isArray(json?.topics)
          ? json.topics
          : [];

      if (rawTopics.length === 0) {
        throw new Error(`Empty topics array returned from ${url}`);
      }

      if (DEBUG) console.log(`[Fetch] Success from: ${url} (${rawTopics.length} raw topics)`);
      return json;

    } catch (error) {
      if (DEBUG) console.warn(`[Fetch] Failed: ${url} →`, error.message);
      lastError = error;
    }
  }

  throw lastError || new Error("All data sources failed.");
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * safeNormalize()
 *
 * Wraps normalizePayload() so that a normalization error (unexpected API shape,
 * etc.) never surfaces as "Data loading failed". Instead it returns an
 * empty-but-valid payload and logs a warning so you can investigate.
 */
function safeNormalize(payload) {
  try {
    return normalizePayload(payload);
  } catch (error) {
    if (DEBUG) console.error("[Normalize] Payload normalization failed →", error);
    return { meta: {}, topics: [], categories: [] };
  }
}

export function normalizePayload(payload) {
  const rawTopics = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.topics)
      ? payload.topics
      : [];

  const topics = rawTopics
    .map((topic, index) => normalizeTopic(topic, index))
    .filter((topic) => topic.newsrooms.length > 0);

  return {
    meta: {
      lastUpdated: payload?.last_updated || null,
      source: payload?.source || (Array.isArray(payload) ? "api" : null),
      topKMatches: payload?.top_k_matches ?? null,
    },
    topics,
    categories: buildCategories(topics),
  };
}

function normalizeTopic(topic, topicIndex) {
  const newsrooms = arrayOf(topic?.rss_stories_with_matches)
    .map((entry, storyIndex) => normalizeStory(entry, topicIndex, storyIndex))
    .filter(Boolean);

  const categories = [...new Set(newsrooms.map((story) => story.category))];
  const finalMissingFacts = stringsOnly(topic?.final_missing_facts);

  return {
    id: slugify(topic?.topic_name || `topic-${topicIndex}`),
    topicName: topic?.topic_name || `Topic ${topicIndex + 1}`,
    totalStories: Number(topic?.total_rss_stories) || newsrooms.length,
    finalMissingFacts,
    newsrooms,
    categories,
    statusCounts: newsrooms.reduce((acc, story) => {
      const status = story.coverageStatus || "unknown";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}),
    totalMissingFacts: newsrooms.reduce((sum, story) => sum + story.missingFacts.length, 0),
  };
}

function normalizeStory(entry, topicIndex, storyIndex) {
  const rssStory = entry?.rss_story || {};
  const missingFacts = stringsOnly(entry?.missing_facts);

  return {
    id: rssStory.id || `story-${topicIndex}-${storyIndex}`,
    newsroom: rssStory.newsroom || "Unknown newsroom",
    title: rssStory.title || "Untitled story",
    summary: rssStory.combined_text_english || rssStory.description || "No English summary available.",
    url: rssStory.url || "",
    publishedAt: rssStory.published_at || "",
    category: String(rssStory.category || "uncategorized").toLowerCase(),
    topicName: rssStory.topic_name || "",
    language: rssStory.language || "",
    matchedCount: arrayOf(entry?.matched_elastic_stories).length,
    missingFacts,
    rawStatus: String(entry?.status || "missed").toLowerCase(),
    coverageStatus: String(entry?.status || "missed").toLowerCase(),
  };
}

// ─── Category helpers ─────────────────────────────────────────────────────────

export function buildCategories(topics) {
  const categoryMap = new Map();

  for (const topic of topics) {
    for (const category of topic.categories) {
      if (!categoryMap.has(category)) {
        categoryMap.set(category, {
          id: category,
          label: titleCase(category),
          topicCount: 0,
          storyCount: 0,
          uncoveredFacts: 0,
        });
      }
      const entry = categoryMap.get(category);
      entry.topicCount += 1;
      entry.storyCount += topic.newsrooms.filter((s) => s.category === category).length;
      entry.uncoveredFacts += topic.totalMissingFacts;
    }
  }

  return [...categoryMap.values()].sort(
    (a, b) => b.topicCount - a.topicCount || a.label.localeCompare(b.label)
  );
}

export function getTopicsForCategory(topics, categoryId) {
  return topics.filter((topic) => topic.categories.includes(categoryId));
}

export function getTopicById(topics, topicId, categoryId = "") {
  const pool = categoryId ? getTopicsForCategory(topics, categoryId) : topics;
  return pool.find((topic) => topic.id === topicId) || null;
}

export function getStoriesForTopic(topic) {
  // Always return all stories within a topic cluster, even if they
  // originated from a different root category than the current dashboard page.
  return topic ? topic.newsrooms : [];
}

export function getStoryById(topic, storyId, categoryId = "") {
  return getStoriesForTopic(topic, categoryId).find((story) => story.id === storyId) || null;
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

export function buildUrl(page, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  return `./${page}${qs ? `?${qs}` : ""}`;
}

// ─── Render helpers ───────────────────────────────────────────────────────────

export function renderLoading(container, message) {
  container.innerHTML = `
    <section class="loading-view">
      <strong>${escapeHtml(message)}</strong>
      <div class="skeleton skeleton-pill-row"></div>
      <div class="skeleton-grid">
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
      </div>
    </section>
  `;
}

export function renderError(container, error) {
  // DEBUG mode: full error shown in UI + console for developer inspection.
  // Production: only a generic message — no internal details leaked.
  if (DEBUG) console.error("[Dashboard Error]", error);
  container.innerHTML = `
    <section class="error-state">
      <strong>Data loading failed</strong>
      ${DEBUG ? `<p>${escapeHtml(error?.message || String(error))}</p>` : ""}
    </section>
  `;
}

export function renderHeaderStats(container, dashboard) {
  if (!container) return;

  if (!dashboard) {
    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-label">Loading</span>
          <div class="stat-value">…</div>
        </div>
      </div>
    `;
    return;
  }

  const topicCount = dashboard.topics.length;
  const lastUpdated = formatDateTime(dashboard.meta?.lastUpdated);

  container.innerHTML = `
    <div class="stats-grid">
      <article class="stat-card">
        <span class="stat-label">Topics</span>
        <div class="stat-value">${formatNumber(topicCount)}</div>
      </article>
    </div>
    <div class="stat-footnote">
      <div><strong>Last updated:</strong> ${escapeHtml(lastUpdated)}</div>
    </div>
  `;
}


export function renderCategoryNav(categories, currentCategory = "") {
  return `
    <section class="filter-shell">
      <div class="filter-row">
        <a class="filter-chip ${currentCategory ? "" : "active"}" href="./index.html">All Categories</a>
        ${categories.map((cat) => `
          <a
            class="filter-chip ${currentCategory === cat.id ? "active" : ""}"
            href="${buildUrl("topics.html", { category: cat.id })}"
          >
            <span>${escapeHtml(cat.label)}</span>
            <span class="chip-count">${formatNumber(cat.topicCount)}</span>
          </a>
        `).join("")}
      </div>
    </section>
  `;
}

export function renderStoryPreview(story) {
  const hasMissingFacts = story.missingFacts.length > 0;

  return `
    <article class="detail-drawer">
      <section class="drawer-section">
        <h4>Story Description</h4>
        <p class="drawer-summary">${escapeHtml(story.summary)}</p>
        <div class="drawer-actions">
          ${story.url
      ? `<a class="action-link" href="${escapeAttribute(story.url)}" target="_blank" rel="noreferrer">Original Story</a>`
      : ""}
          ${story.rawStatus === "undercovered"
      ? `<span class="action-link ghost-link">${formatNumber(story.matchedCount)} matched stories</span>`
      : ""}
        </div>
        <div class="drawer-footnote">
          Category: ${escapeHtml(titleCase(story.category))} — Raw status: ${escapeHtml(titleCase(story.rawStatus))}
        </div>
      </section>
      <section class="drawer-section">
        <h4>Missing Facts</h4>
        ${hasMissingFacts
      ? `<div class="fact-list">${story.missingFacts.map((f) => `<div class="fact-item">${escapeHtml(f)}</div>`).join("")}</div>`
      : `<div class="fact-item covered">Missing Facts Not Found.</div>`}
      </section>
    </article>
  `;
}

export function renderFinalVerdict(topic) {
  return `
    <section class="final-verdict">
      <div class="verdict-head">
        <h3 class="verdict-title">What We Missed</h3>
      </div>
      ${topic.finalMissingFacts.length
      ? `<div class="verdict-grid">
            ${topic.finalMissingFacts.map((fact, i) => `
              <article class="verdict-card">
                <div class="verdict-number">${String(i + 1).padStart(2, "0")}</div>
                <p class="verdict-copy">${escapeHtml(fact)}</p>
              </article>
            `).join("")}
           </div>`
      : `<div class="empty-state">
             <strong>No final undercovering</strong>
             <p>This topic has no aggregate newsroom gap facts in the current response.</p>
           </div>`}
    </section>
  `;
}

// ─── Utility functions ────────────────────────────────────────────────────────

export function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

export function stringsOnly(value) {
  return arrayOf(value)
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function titleCase(value) {
  return String(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

export function formatDateTime(value) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttribute(value) {
  return escapeHtml(value);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function normalizeRefreshInterval(value) {
  const parsed = Number(value);
  // Default: 10 minutes if config is missing or invalid.
  // To change: set refreshIntervalMs in config.js (value in milliseconds).
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1_000;
}

/**
 * Appends a timestamp query param to prevent the browser or CDN from serving
 * a cached copy of the API response or fallback file.
 */
function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_ts=${Date.now()}`;
}

function formatRefreshInterval(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (!rem) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${rem} minute${rem === 1 ? "" : "s"}`;
}