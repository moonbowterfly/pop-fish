/* eslint-disable no-undef */
/**
 * Pop-Fish — journal intelligence for Zotero.
 *
 * What it does
 * ------------
 * For every journal article in the library it keeps a small, locally cached
 * record of that journal's most recent metrics (JIF, 5-year JIF, JCR quartile,
 * CAS division) plus its publication-risk status (CAS early-warning list and
 * predatory-journal listing). Records surface as optional columns in the item
 * tree, can be written into the item's Extra field, and can be inspected or
 * copied from the item context menu.
 *
 * Data comes from the BytesLink (文献泡泡) journal open API:
 *   POST https://api.byteslink.cn/journals/dev/impact-factors/
 *   POST https://api.byteslink.cn/journals/dev/warnings/
 * A single request covers up to 20 journal names and is billed as one call, so
 * everything here is designed around batching and a persistent local cache.
 *
 * Design notes
 * ------------
 * - The item tree calls `dataProvider` synchronously, so it never awaits the
 *   network. A miss queues the journal name and a debounced flush issues one
 *   batched request, then asks Zotero to repaint the columns.
 * - The cache lives next to the Zotero data directory so it survives plugin
 *   updates and library moves without touching prefs.js.
 * - Every network failure is classified (auth / quota / throttle / network)
 *   and put behind a short per-journal backoff so a broken key cannot turn into
 *   a render loop.
 */

{
  const PLUGIN_ID = "popfish@moonbow.dev";
  const PLUGIN_NAME = "Pop-Fish";
  // Bumped together with manifest.json; build.py fails the build if the two
  // ever disagree, so this constant cannot silently drift.
  const PLUGIN_VERSION = "0.2.1";

  const API_BASE = "https://api.byteslink.cn/journals";
  const MAX_PER_REQUEST = 20;
  // Schema 2 fixes the lossy v1 cache key (see loadCache). Never reuse a v1
  // key when a record's original query is available.
  const CACHE_SCHEMA = 2;
  const CACHE_FILE = "popfish-cache.json";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_LAZY_BUDGET = 40;
  const MAX_LAZY_BUDGET = 400;

  const P = {
    apiKey: "popfish.apiKey",
    lazyLookup: "popfish.lazyLookup",
    writeExtra: "popfish.writeExtra",
    extraTag: "popfish.extraTag",
    cacheDays: "popfish.cacheDays",
    colIF: "popfish.column.impactFactor",
    colJCR: "popfish.column.jcr",
    colCAS: "popfish.column.cas",
    colWarn: "popfish.column.warning",
    welcome: "popfish.welcomeShown",
    usage: "popfish.usageJson",
    lastRun: "popfish.lastRun",
    lazyBudget: "popfish.lazyBudget",
  };

  const state = {
    rootURI: null,
    cache: {
      schema: CACHE_SCHEMA,
      updated: 0,
      journals: Object.create(null),
      warnings: Object.create(null),
    },
    cacheLoaded: false,
    cacheLoading: null,
    saveTimer: null,
    // A single serialized chain: every write waits for the previous one, so a
    // flush can never race a background save and leave an older snapshot last.
    saveChain: Promise.resolve(),
    saveDirty: false,
    saveVersion: 0,
    // normalized name -> original spelling, so the server always receives the
    // name the library actually uses (M-03).
    pending: new Map(),
    pendingTimer: null,
    refreshTimer: null,
    onboardTimer: null,
    backoff: new Map(),
    // endpoint + ":" + key -> in-flight Promise (M-03)
    inflight: new Map(),
    // { code, message, until } when the account itself is unusable (M-07)
    accountBlock: null,
    // Stop-the-world flag set by shutdown; every async continuation checks the
    // generation it started under before touching state (M-05).
    stopped: false,
    generation: 0,
    lazyBudgetUsed: 0,
    // Handles owned by the plugin. Every timer created here is cleared on
    // shutdown; a timer that outlives the plugin is a billable bug.
    selfTestTimer: null,
    l10nLinks: [],
    // Cancel functions for HTTP requests currently in the air.
    cancellers: new Set(),
    columns: [],
    menuIDs: [],
    prefPaneID: null,
    nameCache: new Map(),
    stats: { requests: 0, lastUsage: null, lastRunAt: 0, lastError: null },
  };

  // ---------------------------------------------------------------- helpers

  function log(msg) {
    Zotero.debug(`[${PLUGIN_NAME}] ${msg}`);
  }

  function getPref(name, fallback) {
    try {
      const value = Zotero.Prefs.get(name);
      return value === undefined || value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function setPref(name, value) {
    // Callers that show a result to the user must know that the host refused
    // the write. Silently returning success is how the settings pane used to
    // claim "saved" while the API key was still empty.
    if (state.stopped) throw new Error("插件已停止，未写入设置");
    Zotero.Prefs.set(name, value);
  }

  /** Best-effort pref write for bookkeeping that must not abort a workflow. */
  function setPrefSafe(name, value) {
    try {
      setPref(name, value);
      return true;
    } catch (e) {
      log(`cannot write pref ${name}: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * Rejections are not guaranteed to be Error instances on this platform, so
   * never touch `.message` without a guard (the review caught two such paths).
   */
  function errorMessage(e) {
    if (e instanceof Error) return e.message || e.name || "Error";
    if (typeof e === "string") return e;
    try {
      return String(e);
    } catch (inner) {
      return "unknown error";
    }
  }

  function errorCode(e) {
    return (e && typeof e === "object" && e.code) ? String(e.code) : "";
  }

  function apiKey() {
    return String(getPref(P.apiKey, "") || "").trim();
  }

  function hasApiKey() {
    return apiKey().length > 0;
  }

  function lazyBudget() {
    const raw = Number(getPref(P.lazyBudget, DEFAULT_LAZY_BUDGET));
    if (!Number.isFinite(raw)) return DEFAULT_LAZY_BUDGET;
    return Math.max(0, Math.min(MAX_LAZY_BUDGET, Math.floor(raw)));
  }

  function nullMap() {
    return Object.create(null);
  }

  function numericText(value) {
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string" || !value.trim()) return false;
    return Number.isFinite(Number(value));
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Conservative cache identity. Only changes that cannot merge two distinct
   * journal names are applied: Unicode NFKC, non-breaking spaces, whitespace
   * runs and case. Punctuation and leading articles are preserved on purpose,
   * so "A/B", "A:B", "A B" and "B" remain four different keys. Abbreviations
   * and full titles are also kept separate: the plugin does not own an alias
   * table and will not invent one.
   */
  function normalizeName(raw) {
    const text = String(raw == null ? "" : raw);
    if (!text) return "";
    const cached = state.nameCache.get(text);
    if (cached !== undefined) return cached;

    let out = text.normalize ? text.normalize("NFKC") : text;
    out = out.replace(/\u00a0/g, " ");
    out = out.replace(/\s+/g, " ").trim().toLowerCase();

    if (state.nameCache.size > 8000) state.nameCache.clear();
    state.nameCache.set(text, out);
    return out;
  }

  function riskShort(code) {
    if (code === "warning") return "预警";
    if (code === "predatoryjournals_org") return "掠夺";
    return code || "名单";
  }

  function formatDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function publicationOf(item) {
    try {
      if (!item || (item.isRegularItem && !item.isRegularItem())) return "";
      const value = item.getField("publicationTitle");
      return typeof value === "string" ? value.trim() : "";
    } catch (e) {
      return "";
    }
  }

  function cacheTtlMs() {
    const days = Number(getPref(P.cacheDays, 90));
    return Math.max(1, Number.isFinite(days) ? days : 90) * DAY_MS;
  }

  // ------------------------------------------------------------- api client

  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = status || 0;
    }
  }

  /**
   * One API call. A 200 with an unexpected shape is treated as a failed call,
   * not as "no data": silently accepting `{}` used to produce a refresh loop and
   * turned unknown risk into a green check mark.
   */
  async function apiPost(endpoint, journals, overrideKey, gen) {
    const myGen = gen === undefined ? state.generation : gen;
    if (state.stopped || myGen !== state.generation) {
      throw new ApiError("aborted", "插件已停止或缓存已清除，未发起请求", 0);
    }
    const key = String(overrideKey || apiKey()).trim();
    if (!key) throw new ApiError("no-key", "尚未设置 API Key", 0);

    state.stats.requests += 1;
    let xhr;
    let cancel = null;
    try {
      xhr = await Zotero.HTTP.request("POST", `${API_BASE}/dev/${endpoint}/`, {
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ journals: journals.slice(0, MAX_PER_REQUEST) }),
        responseType: "json",
        // Every status is meaningful here: 401/402/429 drive different advice.
        successCodes: false,
        timeout: 25000,
        // We do our own backoff; the built-in retry would silently block the UI.
        noRetryOnThrottle: true,
        // Never let the host turn one failed call into an invisible retry
        // storm; the plugin does not retry errors automatically.
        errorDelayMax: 0,
        logBodyLength: 0,
        // Do not attach any cookie the user may have for this host.
        anon: true,
        // Zotero's HTTP.request hands us a real cancel function here; shutdown
        // and "clear cache" invoke it. Cancelling stops waiting for the
        // response, but it cannot undo a request the server already billed.
        cancellerReceiver: (fn) => {
          if (typeof fn !== "function") return;
          cancel = fn;
          state.cancellers.add(fn);
        },
      });
    } catch (e) {
      if (state.stopped || myGen !== state.generation) {
        throw new ApiError("aborted", "插件已停止或缓存已清除，请求结果被丢弃", 0);
      }
      if (e && (e.name === "CancelledException" || errorMessage(e).includes("Request cancelled"))) {
        // Say exactly what happened: the caller must not claim the server was
        // not charged.
        throw new ApiError("cancelled", "请求已取消（服务端可能仍已计费）", 0);
      }
      throw new ApiError("network", `无法连接期刊服务：${errorMessage(e)}`, 0);
    } finally {
      if (cancel) state.cancellers.delete(cancel);
    }

    if (state.stopped || myGen !== state.generation) {
      throw new ApiError("aborted", "插件已停止或缓存已清除，请求结果被丢弃", 0);
    }

    const status = xhr.status;
    let payload = null;
    try {
      payload = xhr.response && typeof xhr.response === "object" ? xhr.response : null;
    } catch (e) {
      payload = null;
    }

    if (status === 200) {
      if (!payload || !Array.isArray(payload.results)) {
        throw new ApiError(
          "invalid-response",
          "期刊服务返回了无法识别的数据（缺少 results 数组）",
          200,
        );
      }
      return payload;
    }

    const detail = sanitizeDetail(payload && payload.detail, key);
    switch (status) {
      case 401:
        throw new ApiError("auth", detail || "API Key 无效（可能已在网站上重新生成）", 401);
      case 402:
        throw new ApiError("quota", detail || "今日免费额度与付费额度均已用尽", 402);
      case 429:
        throw new ApiError("throttle", detail || "请求过于频繁，请稍后重试", 429);
      case 400:
        throw new ApiError("bad-request", detail || "请求参数有误", 400);
      default:
        throw new ApiError(`http-${status}`, detail || `期刊服务返回 HTTP ${status}`, status);
    }
  }

  /**
   * Server detail strings are shown to the user and written to the debug log.
   * Truncate them, and never let an echo of the key reach either place.
   */
  function sanitizeDetail(text, key) {
    let out = String(text == null ? "" : text).slice(0, 240);
    if (key && key.length > 8) {
      out = out.split(key).join("pp_***");
    }
    return out;
  }

  function recordUsage(usage) {
    if (!usage) return;
    state.stats.lastUsage = Object.assign({}, usage, { at: Date.now() });
    setPrefSafe(P.usage, JSON.stringify(state.stats.lastUsage));
  }

  /**
   * Merge a metrics response. Rows are validated field-by-field; anything
   * unexpected is reported instead of being cached as a real (wrong) answer.
   * Returns { accepted, invalid, missing } so callers can penalise properly.
   */
  function absorbMetrics(results, expected) {
    const now = Date.now();
    const seen = new Set();
    let accepted = 0;
    let invalid = 0;
    const expectedKeys = new Set((expected || []).map((name) => normalizeName(name)).filter(Boolean));

    for (const row of results) {
      if (!row || typeof row.query !== "string") {
        invalid += 1;
        continue;
      }
      const key = normalizeName(row.query);
      if (!key) {
        invalid += 1;
        continue;
      }
      // Only answer for journals this exact request asked about. A row for a
      // different spelling would otherwise create a second paid cache entry.
      if (!expectedKeys.has(key)) {
        invalid += 1;
        continue;
      }

      const found = row.found;
      if (typeof found !== "boolean") {
        invalid += 1;
        continue;
      }

      let record = { q: row.query, found, jif: "", jif5: "", jcr: "", cas: "", ts: now };
      if (found) {
        const factor = row.impact_factor;
        if (!factor || typeof factor !== "object") {
          invalid += 1;
          continue;
        }
        const jif = factor.JIF;
        if (jif == null || jif === "") {
          // "found" without a JIF is not a usable answer.
          invalid += 1;
          continue;
        }
        if (!numericText(jif) || (factor.JIF5 != null && factor.JIF5 !== "" && !numericText(factor.JIF5))) {
          // A non-numeric factor would render as if it were a real metric.
          invalid += 1;
          continue;
        }
        record.jif = String(jif);
        record.jif5 = factor.JIF5 == null ? "" : String(factor.JIF5);
        record.jcr = factor.Q == null ? "" : String(factor.Q);
        record.cas = factor.N == null ? "" : String(factor.N);
      }

      state.cache.journals[key] = record;
      seen.add(key);
      accepted += 1;
    }

    const missing = (expected || []).filter((name) => !seen.has(normalizeName(name)));
    return { accepted, invalid, missing };
  }

  /**
   * Merge a warnings response. `is_warning` must be a real boolean: a row that
   * merely omits it must not be turned into "not flagged".
   */
  function absorbWarnings(results, expected) {
    const now = Date.now();
    const seen = new Set();
    let accepted = 0;
    let invalid = 0;
    const expectedKeys = new Set((expected || []).map((name) => normalizeName(name)).filter(Boolean));

    for (const row of results) {
      if (!row || typeof row.query !== "string") {
        invalid += 1;
        continue;
      }
      const key = normalizeName(row.query);
      if (!key) {
        invalid += 1;
        continue;
      }
      if (!expectedKeys.has(key)) {
        invalid += 1;
        continue;
      }
      if (typeof row.is_warning !== "boolean") {
        invalid += 1;
        continue;
      }

      const rawSources = Array.isArray(row.sources) ? row.sources : [];
      const sources = rawSources.filter(
        (s) => s && typeof s === "object" && typeof s.code === "string" && s.code,
      );
      if (sources.length !== rawSources.length) {
        // A malformed source entry makes the whole risk signal untrustworthy;
        // do not turn "unknown" into a green check mark.
        invalid += 1;
        continue;
      }
      if (row.is_warning && !sources.length) {
        // Flagged but with no source we cannot explain it to the user.
        invalid += 1;
        continue;
      }
      if (!row.is_warning && row.sources != null && !Array.isArray(row.sources)) {
        // An unknown shape must not be recorded as a green "safe" signal.
        invalid += 1;
        continue;
      }

      state.cache.warnings[key] = {
        q: row.query,
        warn: row.is_warning,
        codes: sources.map((s) => String(s.code)),
        names: sources.map((s) => String(s.name || s.name_en || "")).filter(Boolean),
        versions: sources.map((s) => String(s.version || "")).filter(Boolean),
        ts: now,
      };
      seen.add(key);
      accepted += 1;
    }

    const missing = (expected || []).filter((name) => !seen.has(normalizeName(name)));
    return { accepted, invalid, missing };
  }

  function cachePath() {
    const dir = String(Zotero.DataDirectory.dir || "").replace(/[\\/]+$/, "");
    // Mixing separators makes Gecko reject the path on Windows, so prefer the
    // platform joiner and otherwise reuse the directory's own style.
    try {
      if (typeof PathUtils !== "undefined" && PathUtils.join) {
        return PathUtils.join(dir, CACHE_FILE);
      }
    } catch (e) {
      /* fall through to manual join */
    }
    const sep = dir.includes("\\") ? "\\" : "/";
    return `${dir}${sep}${CACHE_FILE}`;
  }

  async function loadCache() {
    if (state.cacheLoaded) return state.cache;
    if (state.cacheLoading) return state.cacheLoading;

    const gen = state.generation;
    state.cacheLoading = (async () => {
      try {
        const text = await Zotero.File.getContentsAsync(cachePath());
        if (state.stopped || gen !== state.generation) return state.cache;
        const parsed = JSON.parse(text);
        const migrated = migrateCache(parsed);
        state.cache.journals = migrated.journals;
        state.cache.warnings = migrated.warnings;
        state.cache.updated = migrated.updated;
        state.cache.schema = CACHE_SCHEMA;
        log(`cache loaded: ${Object.keys(state.cache.journals).length} journals (schema ${parsed && parsed.schema})`);
        if (parsed && parsed.schema !== CACHE_SCHEMA) scheduleSave();
      } catch (e) {
        // A missing cache file is the normal first-run state, not an error.
        log(`cache cold start (${errorMessage(e)})`);
      } finally {
        // Always release the latch: a throwing catch must not leave a rejected
        // promise (or cacheLoaded=false) behind forever.
        if (gen === state.generation) {
          state.cacheLoaded = true;
          state.cacheLoading = null;
        }
      }
      return state.cache;
    })();

    return state.cacheLoading;
  }

  function validTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  }

  function sanitizeMetricsRecord(rec) {
    if (!rec || typeof rec !== "object") return null;
    if (typeof rec.q !== "string" || !rec.q.trim()) return null;
    if (typeof rec.found !== "boolean") return null;
    const ts = validTimestamp(rec.ts);
    if (!ts) return null;
    if (rec.found && (rec.jif == null || rec.jif === "")) return null;
    if (rec.found && (!numericText(rec.jif)
      || (rec.jif5 != null && rec.jif5 !== "" && !numericText(rec.jif5)))) return null;
    return {
      q: rec.q,
      found: rec.found,
      jif: rec.jif == null ? "" : String(rec.jif),
      jif5: rec.jif5 == null ? "" : String(rec.jif5),
      jcr: rec.jcr == null ? "" : String(rec.jcr),
      cas: rec.cas == null ? "" : String(rec.cas),
      ts,
    };
  }

  function sanitizeWarningRecord(rec) {
    if (!rec || typeof rec !== "object") return null;
    if (typeof rec.q !== "string" || !rec.q.trim()) return null;
    if (typeof rec.warn !== "boolean") return null;
    if (!Array.isArray(rec.codes)) return null;
    const codes = rec.codes.filter((c) => typeof c === "string" && c);
    if (rec.warn && !codes.length) return null;
    const ts = validTimestamp(rec.ts);
    if (!ts) return null;
    return {
      q: rec.q,
      warn: rec.warn,
      codes,
      names: Array.isArray(rec.names) ? rec.names.filter((n) => typeof n === "string") : [],
      versions: Array.isArray(rec.versions) ? rec.versions.filter((v) => typeof v === "string") : [],
      ts,
    };
  }

  /**
   * Re-key every record by its own `q`, never by the old cache key: schema 1
   * keys were lossy and cannot be trusted to identify a journal. Records that
   * lack a valid `q` or have the wrong shape are dropped. Writing into a
   * null-prototype object keeps "__proto__" and "constructor" as ordinary
   * journal names instead of prototype mutations.
   */
  function migrateCache(parsed) {
    const journals = nullMap();
    const warnings = nullMap();
    let updated = validTimestamp(parsed && parsed.updated);
    if (!parsed || typeof parsed !== "object") {
      return { journals, warnings, updated };
    }
    if (parsed.schema !== 1 && parsed.schema !== CACHE_SCHEMA) {
      return { journals, warnings, updated };
    }

    for (const rec of Object.values(parsed.journals || {})) {
      const clean = sanitizeMetricsRecord(rec);
      if (!clean) continue;
      const key = normalizeName(clean.q);
      if (!key) continue;
      journals[key] = clean;
      if (!updated && clean.ts) updated = clean.ts;
    }
    for (const rec of Object.values(parsed.warnings || {})) {
      const clean = sanitizeWarningRecord(rec);
      if (!clean) continue;
      const key = normalizeName(clean.q);
      if (!key) continue;
      warnings[key] = clean;
      if (!updated && clean.ts) updated = clean.ts;
    }
    return { journals, warnings, updated };
  }

  /**
   * Queue one serialized snapshot write. Writes never overlap: each waits for
   * the previous one, so the newest snapshot is always the last one on disk.
   */
  function queueWrite() {
    const version = ++state.saveVersion;
    state.cache.updated = Date.now();
    state.cache.schema = CACHE_SCHEMA;
    const text = JSON.stringify(state.cache);

    state.saveChain = state.saveChain
      .catch(() => {}) // one failed write must not poison the chain
      .then(async () => {
        // Let the failure reach the caller (clearCache must not report success
        // when the new empty snapshot never reached the disk). The chain is
        // reset by the catch above on the next write.
        await Zotero.File.putContentsAsync(cachePath(), text);
        if (version >= state.saveVersion) state.saveDirty = false;
      });

    return state.saveChain;
  }

  function scheduleSave() {
    state.saveDirty = true;
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      queueWrite().catch((e) => log(`cache write failed: ${errorMessage(e)}`));
    }, 1200);
  }

  /** Write immediately and resolve once that snapshot is on disk. */
  async function flushCache() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    if (!state.saveDirty && state.saveVersion === 0) return;
    await queueWrite();
  }

  function isStale(record) {
    if (!record) return true;
    return Date.now() - (record.ts || 0) > cacheTtlMs();
  }

  function hasInflightFor(key) {
    const gen = state.generation;
    return state.inflight.has(`impact-factors:${gen}:${key}`)
      || state.inflight.has(`warnings:${gen}:${key}`);
  }

  /**
   * Fetch whatever is missing *or expired* for the given journal names.
   * Requests are shared through `state.inflight`, account-level failures stop
   * the remaining batches, and every result is reported by category instead of
   * being collapsed into "no errors".
   */
  async function ensureData(names, options = {}) {
    await loadCache();

    const empty = {
      requested: 0,
      metricsFetched: 0,
      warningsFetched: 0,
      invalid: 0,
      missing: 0,
      skipped: 0,
      joined: 0,
      errors: [],
      blocked: null,
    };
    if (state.stopped) return Object.assign({}, empty, { blocked: "stopped" });

    const force = !!options.force;
    const gen = state.generation;
    const now = Date.now();
    const ttl = cacheTtlMs();

    const wanted = new Map();
    for (const raw of names || []) {
      const key = normalizeName(raw);
      if (!key || wanted.has(key)) continue;
      wanted.set(key, String(raw).trim());
    }
    if (!wanted.size) return empty;

    // An account-level failure makes further requests pointless and expensive.
    const block = state.accountBlock;
    if (block) {
      if (block.until > now) {
        return Object.assign({}, empty, {
          requested: wanted.size,
          errors: [new ApiError(block.code, block.message, 0)],
          blocked: block.code,
        });
      }
      state.accountBlock = null;
    }

    const needMetrics = [];
    const needWarnings = [];
    let skipped = 0;

    for (const [key, raw] of wanted) {
      const metrics = state.cache.journals[key];
      const warning = state.cache.warnings[key];
      const metricsStale = force || isStale(metrics);
      const warningStale = force || isStale(warning);
      if (!metricsStale && !warningStale) {
        skipped += 1;
        continue;
      }
      // An explicit user action ("update journal data") outranks per-journal backoff.
      if (!force && (state.backoff.get(key) || 0) > now) {
        skipped += 1;
        continue;
      }
      if (metricsStale) needMetrics.push(raw);
      if (warningStale) needWarnings.push(raw);
    }

    const batches = Math.ceil(Math.max(needMetrics.length, needWarnings.length) / MAX_PER_REQUEST);
    const errors = [];
    let metricsFetched = 0;
    let warningsFetched = 0;
    let invalid = 0;
    let missing = 0;
    let joined = 0;
    let done = 0;

    const bump = () => {
      done += 1;
      if (typeof options.onProgress === "function") {
        try {
          options.onProgress(done, batches);
        } catch (e) {
          /* a broken progress callback must not abort the batch */
        }
      }
    };

    for (let i = 0; i < batches * MAX_PER_REQUEST; i += MAX_PER_REQUEST) {
      if (state.stopped || gen !== state.generation) {
        errors.push(new ApiError("aborted", "插件已停止或缓存已被清除，剩余批次未执行", 0));
        break;
      }

      const chunkMetrics = needMetrics.slice(i, i + MAX_PER_REQUEST);
      const chunkWarnings = needWarnings.slice(i, i + MAX_PER_REQUEST);
      const tasks = [];

      if (chunkMetrics.length) {
        tasks.push(
          runEndpointBatch("impact-factors", chunkMetrics, gen)
            .then((res) => {
              metricsFetched += res.accepted;
              invalid += res.invalid;
              missing += res.missing;
              joined += res.joined;
              recordUsage(res.usage);
            })
            .catch((e) => {
              errors.push(e);
              // A request that belonged to an old generation must not throttle
              // or lock the account of the new one.
              if (!state.stopped && gen === state.generation
                && !["aborted", "cancelled"].includes(errorCode(e))) {
                penalize(chunkMetrics, e);
              }
            }),
        );
      }
      if (chunkWarnings.length) {
        tasks.push(
          runEndpointBatch("warnings", chunkWarnings, gen)
            .then((res) => {
              warningsFetched += res.accepted;
              invalid += res.invalid;
              missing += res.missing;
              joined += res.joined;
              recordUsage(res.usage);
            })
            .catch((e) => {
              errors.push(e);
              if (!state.stopped && gen === state.generation
                && !["aborted", "cancelled"].includes(errorCode(e))) {
                penalize(chunkWarnings, e);
              }
            }),
        );
      }

      if (!tasks.length) break;
      await Promise.all(tasks);

      if (state.stopped || gen !== state.generation) break;

      bump();
      scheduleSave();
      refreshColumnsSoon();

      // Authentication, quota and throttling are account-wide: stop here even
      // though the remaining batches were already planned.
      const fatal = errors.find((e) => ["auth", "quota", "no-key", "throttle"].includes(errorCode(e)));
      if (fatal) break;
    }

    const meaningfulErrors = errors.filter(
      (e) => !["aborted", "cancelled"].includes(errorCode(e)),
    );
    if (meaningfulErrors.length && !state.stopped) {
      state.stats.lastError = {
        code: errorCode(meaningfulErrors[0]),
        message: errorMessage(meaningfulErrors[0]),
        at: Date.now(),
      };
    }
    if (!state.stopped) {
      setPrefSafe(P.lastRun, new Date().toISOString());
      state.stats.lastRunAt = Date.now();
    }

    return {
      requested: wanted.size,
      metricsFetched,
      warningsFetched,
      invalid,
      missing,
      skipped,
      joined,
      errors,
      blocked: state.accountBlock ? state.accountBlock.code : null,
    };
  }

  /**
   * One HTTP batch for one endpoint, sharing in-flight work with any other
   * caller that wants the same journal. Results from a stale generation are
   * discarded instead of being written back into a freshly cleared cache.
   */
  async function runEndpointBatch(endpoint, names, gen) {
    const waiting = [];
    const toFetch = [];
    const toFetchKeys = new Set();
    const prefix = `${endpoint}:${gen}:`;

    for (const raw of names) {
      const key = normalizeName(raw);
      if (!key || toFetchKeys.has(key)) continue;
      const pending = state.inflight.get(`${prefix}${key}`);
      if (pending) {
        waiting.push(pending);
      } else {
        toFetch.push(raw);
        toFetchKeys.add(key);
      }
    }

    const out = { accepted: 0, invalid: 0, missing: 0, joined: waiting.length, usage: null };

    if (toFetch.length) {
      const keys = Array.from(toFetchKeys).map((k) => `${prefix}${k}`);
      const promise = apiPost(endpoint, toFetch, undefined, gen);
      for (const k of keys) state.inflight.set(k, promise);

      let payload;
      try {
        payload = await promise;
      } finally {
        for (const k of keys) {
          if (state.inflight.get(k) === promise) state.inflight.delete(k);
        }
      }

      // A cache clear or shutdown happened while the request was in the air.
      // Throw instead of returning an empty result: the caller must not count
      // this as a successful (or penalisable) batch.
      if (state.stopped || gen !== state.generation) {
        throw new ApiError("aborted", "插件已停止或缓存已清除，请求结果被丢弃", 0);
      }

      const absorbed = endpoint === "impact-factors"
        ? absorbMetrics(payload.results, toFetch)
        : absorbWarnings(payload.results, toFetch);

      out.accepted = absorbed.accepted;
      out.invalid = absorbed.invalid;
      out.missing = absorbed.missing.length;
      out.usage = payload.usage || null;

      if (absorbed.missing.length) {
        // Rows the server did not answer for are not cached; keep them out of
        // the immediate retry loop instead of hammering the endpoint.
        penalize(absorbed.missing, new ApiError("invalid-response", "服务端未返回该期刊的结果", 200));
      }
      if (absorbed.invalid) {
        throw new ApiError(
          "invalid-response",
          `服务端返回了 ${absorbed.invalid} 条无法识别的记录`,
          200,
        );
      }
    }

    if (waiting.length) {
      await Promise.all(waiting.map((p) => p.then(() => true).catch(() => false)));
    }

    return out;
  }

  function penalize(names, error) {
    const code = errorCode(error);
    const now = Date.now();

    if (code === "auth" || code === "no-key") {
      // A bad key will fail every remaining request; block the account briefly.
      state.accountBlock = { code, message: errorMessage(error), until: now + 10 * 60 * 1000 };
      log(`account blocked (${code}): ${errorMessage(error)}`);
      return;
    }
    if (code === "quota") {
      state.accountBlock = { code, message: errorMessage(error), until: now + 60 * 60 * 1000 };
      log(`quota exhausted: ${errorMessage(error)}`);
      return;
    }

    const delay = code === "throttle" ? 120000 : 60000;
    for (const raw of names) {
      const key = normalizeName(raw);
      if (key) state.backoff.set(key, now + delay);
    }
    if (code === "throttle") {
      state.accountBlock = { code, message: errorMessage(error), until: now + 60000 };
    }
    log(`batch failed (${code}): ${errorMessage(error)}`);
  }

  /**
   * Queue a journal for the deferred lookup path used by the item tree.
   * Runs from a synchronous data provider, so it only ever schedules.
   */
  function queueLookup(name) {
    if (state.stopped || !getPref(P.lazyLookup, false) || !hasApiKey()) return;
    // Budget is reserved at enqueue time, not at flush time. A synchronous
    // sort can call this hundreds of times before the 700 ms timer fires;
    // checking only in flushPending let one sort spend the whole session.
    const budget = lazyBudget();
    if (state.lazyBudgetUsed >= budget) return;

    const key = normalizeName(name);
    if (!key) return;

    const metrics = state.cache.journals[key];
    const warning = state.cache.warnings[key];
    const fresh = metrics && warning && !isStale(metrics) && !isStale(warning);
    if (fresh) return;
    if ((state.backoff.get(key) || 0) > Date.now()) return;
    if (state.pending.has(key) || hasInflightFor(key)) return;
    if (state.accountBlock && state.accountBlock.until > Date.now()) return;

    state.pending.set(key, String(name).trim());
    state.lazyBudgetUsed += 1;
    if (state.pendingTimer) return;
    state.pendingTimer = setTimeout(flushPending, 700);
  }

  async function flushPending() {
    state.pendingTimer = null;
    // Re-check the switch: the user may have turned lazy lookup off while the
    // debounce timer was waiting.
    if (state.stopped || !getPref(P.lazyLookup, false) || !hasApiKey()) {
      state.pending.clear();
      return;
    }
    if (!state.pending.size) return;

    let entries = Array.from(state.pending.entries());
    // The budget may have been lowered after these entries were reserved.
    // Keep at most what still fits, and refund the reservations we drop.
    const budget = lazyBudget();
    const allowance = Math.max(0, budget - (state.lazyBudgetUsed - entries.length));
    if (entries.length > allowance) {
      const dropped = entries.length - allowance;
      entries = entries.slice(0, allowance);
      state.lazyBudgetUsed = Math.max(0, state.lazyBudgetUsed - dropped);
    }
    state.pending.clear();
    if (!entries.length) return;

    const gen = state.generation;
    const names = entries.map(([, raw]) => raw);
    try {
      await ensureData(names);
    } catch (e) {
      log(`deferred lookup failed: ${errorMessage(e)}`);
    }
    if (state.stopped || gen !== state.generation) return;
    refreshColumnsSoon();
  }

  function clearPendingQueue() {
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    state.pending.clear();
  }

  function columnText(kind, item) {
    const name = publicationOf(item);
    if (!name) return item && item.isRegularItem && item.isRegularItem() ? "无期刊名" : "";

    const key = normalizeName(name);
    const metrics = state.cache.journals[key];
    const warning = state.cache.warnings[key];

    // Expired records still render (so the list is never blank) but are queued
    // for refresh — otherwise the configured TTL would never apply to browsing.
    if (!metrics || !warning || isStale(metrics) || isStale(warning)) {
      queueLookup(name);
    }

    const missingText = () => {
      if (!hasApiKey()) return "未配置 Key";
      if (state.accountBlock && state.accountBlock.until > Date.now()) return "查询已暂停";
      if (state.pending.has(key) || hasInflightFor(key)) return "查询中…";
      if ((state.backoff.get(key) || 0) > Date.now()) return "查询失败";
      if (getPref(P.lazyLookup, false) && state.lazyBudgetUsed >= lazyBudget()) return "预算已用完";
      return "待查询";
    };

    if (kind === "warning") {
      if (!warning) return missingText();
      if (!warning.warn) return "✓";
      const labels = (warning.codes.length ? warning.codes : ["warning"]).map(riskShort);
      return `⚠ ${labels.join("·")}`;
    }

    if (!metrics) return missingText();
    if (!metrics.found) return "—";

    switch (kind) {
      case "if":
        return metrics.jif || "—";
      case "jcr":
        return metrics.jcr ? `Q${metrics.jcr}` : "—";
      case "cas":
        return metrics.cas ? `${metrics.cas}区` : "—";
      default:
        return "";
    }
  }

  function renderCell(_index, data, column, _isFirstColumn, doc) {
    const cell = doc.createElement("span");
    const extraClass = column && column.className ? ` ${column.className}` : "";
    cell.className = `cell${extraClass}`;
    if (data) {
      cell.textContent = data;
      cell.title = data === "待查询"
        ? "打开 Pop-Fish 设置 → 填充当前列表，或右键条目 → 更新期刊数据。查询前会确认费用。"
        : data === "无期刊名"
          ? "此条目没有期刊名，请先补齐「刊名（publicationTitle）」字段。"
          : data;
      if (data.startsWith("⚠")) {
        cell.style.color = "#c0392b";
        cell.style.fontWeight = "600";
      } else if (data === "✓") {
        cell.style.color = "#2f8f4e";
      } else if (data === "—") {
        cell.style.opacity = "0.45";
      }
    }
    return cell;
  }

  // `width` is validated as a string by Zotero's column API even though it
  // ends up as a pixel value, so keep the quotes.
  const COLUMN_DEFS = [
    // Widths leave room for the four/five-character Chinese headers plus the
    // sort arrow; anything tighter truncates them to "影响…".
    { kind: "if", pref: P.colIF, dataKey: "impactFactor", label: "影响因子", width: "110", minWidth: 78 },
    { kind: "jcr", pref: P.colJCR, dataKey: "jcrQuartile", label: "JCR 分区", width: "104", minWidth: 76 },
    { kind: "cas", pref: P.colCAS, dataKey: "casDivision", label: "中科院分区", width: "124", minWidth: 88 },
    { kind: "warning", pref: P.colWarn, dataKey: "journalWarning", label: "期刊预警", width: "116", minWidth: 82 },
  ];

  function registerColumns() {
    const manager = Zotero.ItemTreeManager;
    if (!manager) {
      log("ItemTreeManager unavailable — columns disabled");
      return;
    }
    const registerOne = manager.registerColumn ? manager.registerColumn.bind(manager) : null;
    const registerMany = manager.registerColumns ? manager.registerColumns.bind(manager) : null;

    for (const def of COLUMN_DEFS) {
      if (!getPref(def.pref, true)) continue;
      const option = {
        dataKey: def.dataKey,
        label: def.label,
        pluginID: PLUGIN_ID,
        width: def.width,
        minWidth: def.minWidth,
        flex: 0,
        showInColumnPicker: true,
        // `defaultIn` is deprecated in favour of `enabledTreeIDs`, but it is
        // still the only field that makes a fresh column visible instead of
        // hidden-until-the-user-finds-the-column-picker in views that already
        // define default columns.
        defaultIn: ["default"],
        enabledTreeIDs: ["main"],
        dataProvider: (item) => columnText(def.kind, item),
        renderCell,
        zoteroPersist: ["width", "hidden", "sortDirection", "sortActive"],
      };

      let dataKey = false;
      try {
        if (registerOne) dataKey = registerOne(option);
        else if (registerMany) dataKey = registerMany([option])[0];
      } catch (e) {
        log(`cannot register column ${def.dataKey}: ${errorMessage(e)}`);
      }
      if (dataKey) state.columns.push(dataKey);
    }
    log(`columns registered: ${state.columns.length}`);
  }

  function unregisterColumns() {
    const manager = Zotero.ItemTreeManager;
    if (!manager || !manager.unregisterColumn) {
      state.columns = [];
      return;
    }
    for (const dataKey of state.columns.splice(0)) {
      try {
        manager.unregisterColumn(dataKey);
      } catch (e) {
        log(`cannot unregister column ${dataKey}: ${errorMessage(e)}`);
      }
    }
  }

  function rebuildColumns() {
    unregisterColumns();
    registerColumns();
    refreshColumnsSoon();
  }

  function refreshColumnsSoon() {
    if (state.stopped) return;
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      if (state.stopped) return;
      try {
        Zotero.ItemTreeManager.refreshColumns();
      } catch (e) {
        log(`column refresh failed: ${errorMessage(e)}`);
      }
    }, 450);
  }

  // ------------------------------------------------------------------ extra

  function extraTag() {
    const raw = String(getPref(P.extraTag, "Pop-Fish") || "").trim();
    return raw || "Pop-Fish";
  }

  /**
   * Build the single Extra line that represents this journal. Brackets instead
   * of "Key: value" keep Zotero from treating the tag as a custom field.
   */
  /**
   * Build the single Extra line for this journal. Metrics and risk carry their
   * own timestamps: a partially refreshed journal must not look like its older
   * half was just checked.
   */
  function buildExtraLine(name) {
    const key = normalizeName(name);
    const metrics = state.cache.journals[key];
    const warning = state.cache.warnings[key];
    if (!metrics && !warning) return null;

    const parts = [];
    if (metrics) {
      if (metrics.found) {
        if (metrics.jif) parts.push(`JIF=${metrics.jif}`);
        if (metrics.jif5) parts.push(`JIF5=${metrics.jif5}`);
        if (metrics.jcr) parts.push(`JCR=Q${metrics.jcr}`);
        if (metrics.cas) parts.push(`CAS=${metrics.cas}`);
      } else {
        parts.push("JCR=not-indexed");
      }
    }
    if (warning) {
      const codes = warning.warn ? (warning.codes.length ? warning.codes : ["warning"]) : ["no"];
      parts.push(`Warning=${codes.map((c) => (c === "no" ? "no" : riskShort(c))).join("+")}`);
    }
    if (!parts.length) return null;

    const metricsStamp = metrics ? formatDate(metrics.ts) : "";
    const warningStamp = warning ? formatDate(warning.ts) : "";
    if (metricsStamp) parts.push(`Metrics=${metricsStamp}`);
    if (warningStamp) parts.push(`Risk=${warningStamp}`);
    return `[${extraTag()}] ${parts.join("; ")}`;
  }

  /**
   * Write the tag line into each editable item. Read-only items (shared group
   * libraries, locked libraries) are skipped and counted instead of aborting
   * the whole batch at save time.
   */
  async function applyExtra(items) {
    if (state.stopped) return { changed: 0, skippedReadOnly: 0, failed: 0, aborted: true };
    if (!getPref(P.writeExtra, true)) return { changed: 0, skippedReadOnly: 0, failed: 0 };
    const gen = state.generation;
    const tag = extraTag();
    const tagRe = new RegExp(`^\\s*\\[${escapeRegExp(tag)}\\]`);

    const dirty = [];
    let skippedReadOnly = 0;
    let failed = 0;

    for (const item of items) {
      const name = publicationOf(item);
      if (!name) continue;
      const line = buildExtraLine(name);
      if (!line) continue;

      try {
        if (typeof item.isEditable === "function" && !item.isEditable()) {
          skippedReadOnly += 1;
          continue;
        }
      } catch (e) {
        skippedReadOnly += 1;
        continue;
      }

      let extra = "";
      try {
        extra = item.getField("extra") || "";
      } catch (e) {
        failed += 1;
        continue;
      }

      const lines = extra.length ? extra.split(/\r?\n/) : [];
      const index = lines.findIndex((l) => tagRe.test(l));
      if (index >= 0) {
        if (lines[index] === line) continue;
        lines[index] = line;
      } else {
        lines.push(line);
      }

      const next = lines.join("\n").replace(/\s+$/, "");
      // Stage plain values only. Do not dirty every item in memory before the
      // first await: a later shutdown must leave not-yet-saved items untouched.
      dirty.push({ item, next });
    }

    if (dirty.length) {
      // The plugin may have been disabled while the loop was preparing rows.
      // Never open a transaction after shutdown.
      if (state.stopped || gen !== state.generation) {
        return { changed: 0, skippedReadOnly, failed, aborted: true };
      }
      try {
        await Zotero.DB.executeTransaction(async () => {
          for (const { item, next } of dirty) {
            if (state.stopped || gen !== state.generation) {
              throw new ApiError("aborted", "插件已停止或缓存已清除，Extra 事务已取消", 0);
            }
            item.setField("extra", next);
            await item.save();
          }
          if (state.stopped || gen !== state.generation) {
            throw new ApiError("aborted", "插件已停止或缓存已清除，Extra 事务已取消", 0);
          }
        });
      } catch (e) {
        if (errorCode(e) === "aborted") {
          return { changed: 0, skippedReadOnly, failed, aborted: true };
        }
        log(`Extra transaction failed: ${errorMessage(e)}`);
        return { changed: 0, skippedReadOnly, failed: failed + dirty.length };
      }
    }
    return { changed: dirty.length, skippedReadOnly, failed };
  }

  // ------------------------------------------------------------------- ui

  function notify(headline, lines = [], timeout = 6000) {
    if (state.stopped) return null;
    try {
      const win = new Zotero.ProgressWindow({ closeOnClick: true });
      win.changeHeadline(headline);
      for (const line of lines) {
        if (line) win.addDescription(line);
      }
      win.show();
      win.startCloseTimer(timeout);
      return win;
    } catch (e) {
      log(`notification failed: ${errorMessage(e)}`);
      return null;
    }
  }

  function openPreferences() {
    try {
      Zotero.Utilities.Internal.openPreferences("popfish-preferences");
    } catch (e) {
      log(`cannot open preferences: ${errorMessage(e)}`);
    }
  }

  function selectedItems() {
    try {
      const pane = Zotero.getActiveZoteroPane();
      return pane ? pane.getSelectedItems() : [];
    } catch (e) {
      return [];
    }
  }

  function itemsWithJournals(items) {
    return (items || []).filter((item) => publicationOf(item));
  }

  function summarizeError(error) {
    if (!error) return "未知错误";
    switch (error.code) {
      case "no-key":
        return "尚未设置 API Key，请在设置中填入。";
      case "auth":
        return "API Key 无效——请到文献泡泡「用户中心 → 我的 API」核对。";
      case "quota":
        return "额度已用尽，可明日再用或到用户中心充值。";
      case "throttle":
        return "请求过于频繁，请稍后再试。";
      case "network":
        return "网络不通，请检查代理或稍后重试。";
      default:
        return errorMessage(error);
    }
  }

  // -------------------------------------------------------------- workflows

  /**
   * Cancel every HTTP request currently in the air. Zotero's
   * `cancellerReceiver` callback rejects the request promise, but the server
   * may already have counted (and billed) the call. Callers must not present
   * cancellation as a refund.
   */
  function cancelInflight() {
    const cancels = Array.from(state.cancellers);
    state.cancellers.clear();
    for (const cancel of cancels) {
      try {
        cancel();
      } catch (e) {
        log(`cannot cancel request: ${errorMessage(e)}`);
      }
    }
    return cancels.length;
  }

  /**
   * Count what a manual batch would actually request, without sending
   * anything. The request number is an upper bound: one batch per 20 journal
   * names per endpoint, and force means every journal is queried on both
   * endpoints. It is not a balance and it cannot guarantee the final charge.
   */
  async function buildPreflight(items, options = {}) {
    await loadCache();
    const force = !!options.force;
    const now = Date.now();
    const seen = new Set();
    const journals = [];

    for (const item of items || []) {
      const name = publicationOf(item);
      const key = normalizeName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      journals.push({ key, name });
    }

    let metricsNeeded = 0;
    let warningsNeeded = 0;
    let fresh = 0;
    let backingOff = 0;
    for (const entry of journals) {
      const metrics = state.cache.journals[entry.key];
      const warning = state.cache.warnings[entry.key];
      const metricsStale = force || isStale(metrics);
      const warningStale = force || isStale(warning);
      if (!metricsStale && !warningStale) {
        fresh += 1;
        continue;
      }
      if (!force && (state.backoff.get(entry.key) || 0) > now) {
        backingOff += 1;
        continue;
      }
      if (metricsStale) metricsNeeded += 1;
      if (warningStale) warningsNeeded += 1;
    }

    const block = state.accountBlock && state.accountBlock.until > now ? state.accountBlock : null;
    const requests = block
      ? 0
      : Math.ceil(metricsNeeded / MAX_PER_REQUEST) + Math.ceil(warningsNeeded / MAX_PER_REQUEST);
    return {
      journals: journals.length,
      metricsNeeded,
      warningsNeeded,
      requests,
      force,
      fresh,
      backingOff,
      blocked: block ? block.code : null,
      allCached: requests === 0 && !block,
      names: journals.map((entry) => entry.name),
    };
  }

  function preflightText(preflight, headline) {
    return [
      headline,
      `涉及 ${preflight.journals} 种期刊：指标 ${preflight.metricsNeeded} 个，风险 ${preflight.warningsNeeded} 个待查。`,
      `预计最多 ${preflight.requests} 次接口请求（每批 ${MAX_PER_REQUEST} 个刊名、两个接口分别估算）。`,
      "这是请求数上限，不是账户余额，也不保证最终扣费与估算一致。",
      "取消不会发起任何请求，也不会写入 Extra。",
    ].join("\n");
  }

  /**
   * Ask the user before spending money. Returns false on cancel and whenever
   * the host has no prompt available (fail closed rather than silently bill).
   */
  function confirmPreflight(preflight, headline) {
    if (!preflight.requests) return true;
    const text = preflightText(preflight, headline);
    const title = `${PLUGIN_NAME} · 确认查询费用`;
    try {
      const prompt = typeof Services !== "undefined" ? Services.prompt : null;
      if (!prompt) return false;
      const win = (() => {
        try {
          return Zotero.getMainWindow();
        } catch (e) {
          return null;
        }
      })();
      if (typeof prompt.confirmEx === "function") {
        const flags = prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_0
          + prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_1;
        return prompt.confirmEx(
          win, title, text, flags, "继续查询", "取消", null, null, {},
        ) === 0;
      }
      if (typeof prompt.confirm === "function") {
        return !!prompt.confirm(win, title, text);
      }
      return false;
    } catch (e) {
      log(`confirmation failed: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * Query + write for a set of items, with every stage reporting its own
   * outcome. Nothing here is allowed to reject: the menu callbacks cannot
   * surface a rejected promise to the user.
   */
  async function runUpdate(items, options = {}) {
    const headline = options.headline || PLUGIN_NAME;
    if (state.stopped) return { items: 0, journals: 0, errors: [], blocked: "stopped", aborted: true };
    if (!hasApiKey()) {
      notify(headline, ["尚未设置 API Key", "已为你打开设置面板"]);
      openPreferences();
      return { items: 0, journals: 0, errors: [], blocked: "no-key" };
    }

    const preflight = await buildPreflight(items, { force: !!options.force });
    if (state.stopped) {
      return { items: 0, journals: 0, errors: [], blocked: "stopped", aborted: true };
    }
    const names = preflight.names;
    if (!names.length) {
      notify(headline, ["没有找到带期刊名的条目"]);
      return { items: 0, journals: 0, errors: [], blocked: null };
    }
    if (preflight.blocked) {
      notify(headline, [summarizeError({ code: preflight.blocked, message: "" })], 9000);
      return { items: items.length, journals: names.length, errors: [], blocked: preflight.blocked, requests: 0 };
    }
    if (preflight.requests && !confirmPreflight(preflight, headline)) {
      log(`update cancelled before any request (${preflight.requests} estimated)`);
      return {
        items: items.length,
        journals: names.length,
        errors: [],
        blocked: null,
        cancelled: true,
        requests: 0,
      };
    }
    if (state.stopped) {
      return { items: 0, journals: 0, errors: [], blocked: "stopped", aborted: true };
    }

    const gen = state.generation;
    const progress = preflight.requests
      ? notify(headline, [`${items.length} 篇条目 / ${names.length} 种期刊，正在查询…`], 60000)
      : null;
    const started = Date.now();

    let result;
    try {
      result = await ensureData(names, {
        force: !!options.force,
        onProgress: (done, total) => {
          if (progress && total > 1) {
            try {
              progress.addDescription(`已完成 ${done}/${total} 批`);
            } catch (e) {
              /* the window may be gone */
            }
          }
        },
      });
    } catch (e) {
      if (state.stopped || gen !== state.generation || errorCode(e) === "aborted") {
        return { items: items.length, journals: names.length, errors: [e], blocked: "aborted", aborted: true };
      }
      notify(headline, [`查询失败：${errorMessage(e)}`], 9000);
      log(`update failed: ${errorMessage(e)}`);
      return { items: items.length, journals: names.length, errors: [e], blocked: errorCode(e) || null };
    }

    if (state.stopped || gen !== state.generation) {
      return { items: items.length, journals: names.length, errors: [], blocked: "aborted", aborted: true };
    }

    let extra = { changed: 0, skippedReadOnly: 0, failed: 0 };
    try {
      extra = await applyExtra(items);
    } catch (e) {
      log(`Extra stage failed: ${errorMessage(e)}`);
      extra.failed = items.length;
    }

    if (state.stopped || gen !== state.generation) {
      return { items: items.length, journals: names.length, errors: [], blocked: "aborted", aborted: true };
    }

    refreshColumnsSoon();

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const lines = [`${items.length} 篇条目 · ${names.length} 种期刊 · ${seconds}s`];

    const fetched = result.metricsFetched + result.warningsFetched;
    if (fetched === 0 && result.skipped > 0) lines.push("全部命中本地缓存，未发起请求");
    else lines.push(`新获取 ${result.metricsFetched} 条指标 / ${result.warningsFetched} 条风险记录`);

    if (result.skipped) lines.push(`${result.skipped} 种期刊因缓存有效或退避被跳过`);

    const extraBits = [`Extra 更新 ${extra.changed} 条`];
    if (extra.skippedReadOnly) extraBits.push(`${extra.skippedReadOnly} 条只读跳过`);
    if (extra.failed) extraBits.push(`${extra.failed} 条失败`);
    lines.push(extraBits.join(" · "));

    if (result.blocked) {
      lines.push(summarizeError({ code: result.blocked, message: (result.errors[0] && errorMessage(result.errors[0])) || "" }));
    } else if (result.errors.length) {
      lines.push(summarizeError(result.errors[0]));
    }
    if (result.invalid) lines.push(`服务端返回 ${result.invalid} 条异常记录，已跳过`);
    if (result.missing) lines.push(`服务端缺失 ${result.missing} 条期刊结果，请稍后重试`);
    if (state.stats.lastUsage) {
      const usage = state.stats.lastUsage;
      lines.push(`本次计费来源：${usage.source === "free" ? "免费额度" : "付费额度"}`);
    }

    notify(headline, lines, 8000);
    return {
      items: items.length,
      journals: names.length,
      changed: extra.changed,
      skippedReadOnly: extra.skippedReadOnly,
      errors: result.errors,
      blocked: result.blocked,
      missing: result.missing,
      invalid: result.invalid,
      incomplete: names.filter(name => {
        const key = normalizeName(name);
        return isStale(state.cache.journals[key]) || isStale(state.cache.warnings[key]);
      }).length,
    };
  }

  async function updateSelected() {
    try {
      const items = itemsWithJournals(selectedItems());
      if (!items.length) {
        notify(PLUGIN_NAME, ["选中的条目没有期刊名（publicationTitle）"]);
        return;
      }
      await runUpdate(items, { force: true, headline: "更新期刊数据" });
    } catch (e) {
      log(`updateSelected failed: ${errorMessage(e)}`);
      notify(PLUGIN_NAME, [`更新失败：${errorMessage(e)}`], 9000);
    }
  }

  async function copySnapshot() {
    if (state.stopped) return;
    try {
      const items = itemsWithJournals(selectedItems());
      if (!items.length) {
        notify(PLUGIN_NAME, ["选中的条目没有期刊名"]);
        return;
      }

      const out = [];
      for (const item of items) {
        const name = publicationOf(item);
        const key = normalizeName(name);
        const metrics = state.cache.journals[key];
        const warning = state.cache.warnings[key];

        out.push(`## ${item.getField("title") || "(no title)"}`);
        out.push(`Journal: ${name}`);
        if (metrics) {
          if (metrics.found) {
            out.push(`JIF: ${metrics.jif || "-"}  |  JIF5: ${metrics.jif5 || "-"}`);
            out.push(`JCR: ${metrics.jcr ? "Q" + metrics.jcr : "-"}  |  CAS: ${metrics.cas ? metrics.cas + " 区" : "-"}`);
          } else {
            out.push("JCR: 未收录 / 名称未匹配");
          }
          out.push(`Metrics checked: ${formatDate(metrics.ts)}`);
        } else {
          out.push("Metrics: 尚未查询");
        }
        if (warning) {
          out.push(
            warning.warn
              ? `Warning: 命中 ${warning.names.join("、") || warning.codes.join("、")}`
              : "Warning: 未命中预警 / 掠夺性期刊名单",
          );
          out.push(`Risk checked: ${formatDate(warning.ts)}`);
        } else {
          out.push("Warning: 尚未查询");
        }
        out.push("");
      }

      if (state.stopped) return;
      Zotero.Utilities.Internal.copyTextToClipboard(out.join("\n"));
      notify(PLUGIN_NAME, ["期刊快照已复制到剪贴板"]);
    } catch (e) {
      log(`copySnapshot failed: ${errorMessage(e)}`);
      notify(PLUGIN_NAME, [`复制失败：${errorMessage(e)}`], 9000);
    }
  }

  async function scanCollection() {
    if (state.stopped) return;
    try {
      const pane = Zotero.getActiveZoteroPane();
      const collection = pane ? pane.getSelectedCollection() : null;
      if (!collection) {
        notify(PLUGIN_NAME, ["请先在左侧选中一个分类"]);
        return;
      }
      const children = await collection.getChildItems();
      if (state.stopped) return;
      const items = itemsWithJournals(children);
      if (!items.length) {
        notify(PLUGIN_NAME, [`分类「${collection.name}」里没有带期刊名的条目`]);
        return;
      }
      await runUpdate(items, { headline: `体检分类「${collection.name}」` });
    } catch (e) {
      log(`scanCollection failed: ${errorMessage(e)}`);
      notify(PLUGIN_NAME, [`体检失败：${errorMessage(e)}`], 9000);
    }
  }

  async function scanCurrentView() {
    if (state.stopped) return { aborted: true };
    try {
      const pane = Zotero.getActiveZoteroPane();
      if (!pane || typeof pane.getSortedItems !== "function") {
        return { blocked: "no-view", errors: [], items: 0, journals: 0 };
      }
      // Respect the current collection/search filter. Never silently expand a
      // first-use action into a query of the entire library.
      const items = itemsWithJournals(pane.getSortedItems());
      if (!items.length) {
        return { blocked: "no-journals", errors: [], items: 0, journals: 0 };
      }
      return await runUpdate(items, { headline: "填充当前列表期刊数据" });
    } catch (e) {
      log(`scanCurrentView failed: ${errorMessage(e)}`);
      return { blocked: errorCode(e) || "failed", errors: [e], items: 0, journals: 0 };
    }
  }

  async function scanLibrary() {
    if (state.stopped) return;
    try {
      const pane = Zotero.getActiveZoteroPane();
      const libraryID = (pane && pane.getSelectedLibraryID && pane.getSelectedLibraryID()) || Zotero.Libraries.userLibraryID;
      const all = await Zotero.Items.getAll(libraryID, true);
      if (state.stopped) return;
      const items = itemsWithJournals(all);
      if (!items.length) {
        notify(PLUGIN_NAME, ["这个文库中没有带期刊名的条目"]);
        return;
      }
      await runUpdate(items, { headline: "体检整个文库" });
    } catch (e) {
      log(`scanLibrary failed: ${errorMessage(e)}`);
      notify(PLUGIN_NAME, [`体检失败：${errorMessage(e)}`], 9000);
    }
  }

  async function clearCache() {
    if (state.stopped) return { ok: false, error: "插件已停止" };
    // Move to a new generation first, then cancel the old requests. Their
    // finally blocks only remove their own generation-tagged entries, so a new
    // request for the same journal can start immediately.
    state.generation += 1;
    const cancelled = cancelInflight();
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    state.cache.journals = nullMap();
    state.cache.warnings = nullMap();
    state.cache.schema = CACHE_SCHEMA;
    state.cache.updated = Date.now();
    state.cacheLoaded = true;
    state.cacheLoading = null;
    state.backoff.clear();
    state.pending.clear();
    // Deliberately NOT reset: the session budget and an auth/quota account
    // lock must survive a cache clear, otherwise clearing is a free way to
    // bypass both cost controls.
    refreshColumnsSoon();
    state.saveDirty = true;
    try {
      await flushCache();
    } catch (e) {
      const msg = errorMessage(e);
      log(`clear cache write failed: ${msg}`);
      return { ok: false, cancelled, error: msg };
    }
    notify(PLUGIN_NAME, [
      "已清除本地期刊缓存",
      "下次浏览或更新时会重新查询",
      cancelled ? "已取消在途请求；服务端可能仍已计费" : "",
    ].filter(Boolean));
    return { ok: true, cancelled };
  }

  // ----------------------------------------------------------------- menus

  // Fluent strings for the context menu. The plugin's .ftl files are registered
  // by Zotero under the `zotero-plugins` source, but the main window only picks
  // them up once the source is linked into its document, so every window gets
  // an explicit insertFTLIfNeeded() below. These literals are the safety net for
  // the first paint, before Fluent has resolved the bundle.
  const MENU_TEXT = {
    update: { zh: "更新期刊数据", en: "Update journal data" },
    copy: { zh: "复制期刊快照", en: "Copy journal snapshot" },
    more: { zh: "期刊工具", en: "Journal tools" },
    scanCollection: { zh: "体检当前分类", en: "Check this collection" },
    scanLibrary: { zh: "体检整个文库", en: "Check the whole library" },
    clearCache: { zh: "清除期刊缓存", en: "Clear journal cache" },
    settings: { zh: "Pop-Fish 设置…", en: "Pop-Fish settings…" },
  };

  function preferChinese() {
    try {
      return String(Services.locale.appLocaleAsBCP47 || "").toLowerCase().startsWith("zh");
    } catch (e) {
      return true;
    }
  }

  function menuLabel(key) {
    const entry = MENU_TEXT[key];
    if (!entry) return "";
    return preferChinese() ? entry.zh : entry.en;
  }

  function setFallbackLabel(context, key) {
    try {
      const elem = context && context.menuElem;
      if (!elem || elem.getAttribute("label")) return;
      const text = menuLabel(key);
      if (text) elem.setAttribute("label", text);
    } catch (e) {
      /* a label is cosmetic; never let it break the menu */
    }
  }

  /**
   * Fluent resolves plugin files registered by Zotero under the
   * `zotero-plugins` source. `insertFTLIfNeeded` expects the resource name
   * ("popfish-addon.ftl"), not a `file:`/`jar:` URL from the plugin root.
   * Passing an absolute URL made the old build log "linked" while every
   * formatValues() call returned null.
   */
  function linkLocalization(window) {
    if (!window || !window.MozXULElement || !window.MozXULElement.insertFTLIfNeeded) return;
    const doc = window.document;
    if (!doc) return;
    try {
      if (doc.querySelector && doc.querySelector('link[data-popfish-l10n="1"]')) return;
      const before = doc.querySelectorAll
        ? Array.from(doc.querySelectorAll('link[rel="localization"]'))
        : [];
      window.MozXULElement.insertFTLIfNeeded("popfish-addon.ftl");
      const after = doc.querySelectorAll
        ? Array.from(doc.querySelectorAll('link[rel="localization"]'))
        : [];
      for (const link of after) {
        if (before.includes(link)) continue;
        try {
          link.setAttribute("data-popfish-l10n", "1");
          state.l10nLinks.push(link);
        } catch (e) {
          /* a readonly link is still harmless */
        }
      }
      log("linked popfish-addon.ftl");
    } catch (e) {
      log(`cannot link popfish-addon.ftl: ${errorMessage(e)}`);
    }
  }

  function removeL10nLinks(doc) {
    const keep = [];
    for (const link of state.l10nLinks) {
      const owner = link && link.ownerDocument;
      if (doc && owner !== doc) {
        keep.push(link);
        continue;
      }
      try {
        link.remove();
      } catch (e) {
        try {
          link.parentNode && link.parentNode.removeChild(link);
        } catch (inner) {
          /* already gone */
        }
      }
    }
    state.l10nLinks = keep;
  }

  const MENU_ID_ITEM = "popfish-item-menu";
  const MENU_ID_COLLECTION = "popfish-collection-menu";

  function registerMenus() {
    const manager = Zotero.MenuManager;
    if (!manager || !manager.registerMenu) {
      log("MenuManager unavailable — context menu disabled");
      return;
    }

    const itemMenus = [
      {
        menuType: "menuitem",
        l10nID: "popfish-menu-update",
        onShowing: (_event, context) => {
          setFallbackLabel(context, "update");
          context.setEnabled(itemsWithJournals(selectedItems()).length > 0);
        },
        onCommand: () => {
          updateSelected();
        },
      },
      {
        menuType: "menuitem",
        l10nID: "popfish-menu-copy",
        onShowing: (_event, context) => {
          setFallbackLabel(context, "copy");
          context.setEnabled(itemsWithJournals(selectedItems()).length > 0);
        },
        onCommand: () => {
          copySnapshot();
        },
      },
      {
        menuType: "submenu",
        l10nID: "popfish-menu-more",
        onShowing: (_event, context) => setFallbackLabel(context, "more"),
        menus: [
          {
            menuType: "menuitem",
            l10nID: "popfish-menu-scan-collection",
            onShowing: (_event, context) => setFallbackLabel(context, "scanCollection"),
            onCommand: () => {
              scanCollection();
            },
          },
          {
            menuType: "menuitem",
            l10nID: "popfish-menu-scan-library",
            onShowing: (_event, context) => setFallbackLabel(context, "scanLibrary"),
            onCommand: () => {
              scanLibrary();
            },
          },
          { menuType: "separator" },
          {
            menuType: "menuitem",
            l10nID: "popfish-menu-clear-cache",
            onShowing: (_event, context) => setFallbackLabel(context, "clearCache"),
            onCommand: async () => {
              const result = await clearCache();
              if (result && result.ok === false) {
                notify(PLUGIN_NAME, [`清除缓存失败：${result.error || "磁盘写入失败"}`], 9000);
              }
            },
          },
          {
            menuType: "menuitem",
            l10nID: "popfish-menu-settings",
            onShowing: (_event, context) => setFallbackLabel(context, "settings"),
            onCommand: () => {
              openPreferences();
            },
          },
        ],
      },
    ];

    const collectionMenus = [
      {
        menuType: "menuitem",
        l10nID: "popfish-menu-scan-collection",
        onShowing: (_event, context) => {
          setFallbackLabel(context, "scanCollection");
          const pane = Zotero.getActiveZoteroPane();
          context.setEnabled(!!(pane && pane.getSelectedCollection && pane.getSelectedCollection()));
        },
        onCommand: () => {
          scanCollection();
        },
      },
    ];

    for (const [menuID, target, menus] of [
      [MENU_ID_ITEM, "main/library/item", itemMenus],
      [MENU_ID_COLLECTION, "main/library/collection", collectionMenus],
    ]) {
      try {
        const registered = manager.registerMenu({ menuID, pluginID: PLUGIN_ID, target, menus });
        // registerMenu returns the namespaced key; unregister only accepts that.
        if (registered) state.menuIDs.push(registered);
      } catch (e) {
        log(`cannot register menu ${menuID}: ${errorMessage(e)}`);
      }
    }
    log(`menus registered: ${state.menuIDs.length}`);
  }

  function unregisterMenus() {
    const manager = Zotero.MenuManager;
    if (!manager || !manager.unregisterMenu) {
      state.menuIDs = [];
      return;
    }
    for (const menuID of state.menuIDs.splice(0)) {
      try {
        if (manager.unregisterMenu(menuID) === false) {
          log(`menu ${menuID} was already gone`);
        }
      } catch (e) {
        log(`cannot unregister menu ${menuID}: ${errorMessage(e)}`);
      }
    }
  }

  // ---------------------------------------------------------- pref pane api

  async function registerPrefPane(rootURI) {
    try {
      await Zotero.PreferencePanes.register({
        pluginID: PLUGIN_ID,
        id: "popfish-preferences",
        label: PLUGIN_NAME,
        image: `${rootURI}chrome/content/icons/favicon.png`,
        src: `${rootURI}chrome/content/preferences.xhtml`,
        scripts: [`${rootURI}chrome/content/scripts/preferences.js`],
      });
      state.prefPaneID = "popfish-preferences";
      log("preference pane registered");
    } catch (e) {
      log(`cannot register preference pane: ${errorMessage(e)}`);
    }
  }

  function cacheStats() {
    const budget = lazyBudget();
    const block = state.accountBlock && state.accountBlock.until > Date.now()
      ? state.accountBlock
      : null;
    return {
      journals: Object.keys(state.cache.journals).length,
      warnings: Object.keys(state.cache.warnings).length,
      updated: state.cache.updated,
      path: cachePath(),
      requests: state.stats.requests,
      lastUsage: state.stats.lastUsage,
      lastError: state.stats.lastError,
      lazyBudgetUsed: state.lazyBudgetUsed,
      lazyBudget: budget,
      lazyBudgetRemaining: Math.max(0, budget - state.lazyBudgetUsed),
      pending: state.pending.size,
      inflight: state.inflight.size,
      accountBlock: block ? { code: block.code, message: block.message, until: block.until } : null,
      autoPaused: !!block,
    };
  }

  /**
   * Probe the service with the key currently typed in the settings pane, so
   * users get feedback before saving. Never logs the key itself.
   */
  /**
   * Probe the service with the key currently typed in the settings pane, so
   * users get feedback before saving. Validates the sample row: a 200 with an
   * empty body must not be reported as a healthy connection.
   */
  async function testConnection(key) {
    if (state.stopped) throw new ApiError("aborted", "插件已停止，未发起探测请求", 0);
    const gen = state.generation;
    await loadCache();
    if (state.stopped || gen !== state.generation) throw new ApiError("aborted", "连接检测已取消", 0);
    const started = Date.now();
    const payload = await apiPost("impact-factors", ["Nature"], key);
    const row = (payload.results || []).find(
      (r) => r && typeof r.query === "string" && normalizeName(r.query) === "nature",
    );
    if (!row || row.found !== true || !row.impact_factor || row.impact_factor.JIF == null) {
      throw new ApiError("invalid-response", "探测响应中缺少 Nature 的指标数据", 200);
    }
    if (state.stopped || gen !== state.generation) throw new ApiError("aborted", "连接检测已取消", 0);
    const merged = absorbMetrics([row], ["Nature"]);
    if (merged.accepted !== 1) {
      throw new ApiError("invalid-response", "探测响应中的 Nature 指标格式无效", 200);
    }
    recordUsage(payload.usage);
    scheduleSave();
    refreshColumnsSoon();
    return {
      ok: true,
      latencyMs: Date.now() - started,
      usage: payload.usage || null,
      sample: row.impact_factor,
    };
  }

  function rebuildFromSettings() {
    rebuildColumns();
  }

  /**
   * End-to-end diagnostic used by the settings pane and by automated smoke
   * tests. Exercises the key, the batched lookup path, the cache and the
   * column renderers against real library data, then writes one JSON line to
   * the debug log so headless runs can verify the result.
   */
  async function selfTest() {
    if (state.stopped) return { aborted: true, error: "插件已停止" };
    try {
      return await selfTestInner();
    } catch (e) {
      const msg = errorMessage(e);
      log(`SELFTEST FAILED ${msg}`);
      return { error: msg };
    }
  }

  async function selfTestInner() {
    const report = {
      version: PLUGIN_VERSION,
      apiKeySet: hasApiKey(),
      columns: state.columns.slice(),
      menus: state.menuIDs.slice(),
      cachePath: cachePath(),
      cacheJournals: Object.keys(state.cache.journals).length,
    };

    try {
      const probe = await testConnection();
      report.connection = {
        ok: true,
        latencyMs: probe.latencyMs,
        sample: probe.sample,
        usage: probe.usage,
      };
    } catch (e) {
      report.connection = { ok: false, code: errorCode(e), message: errorMessage(e) };
    }

    let names = [];
    if (getPref("popfish.seedTestItems", false)) {
      try {
        report.seeded = await seedTestItems();
      } catch (e) {
        report.seedError = errorMessage(e);
      }
    }
    try {
      const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
      for (const item of items) {
        const name = publicationOf(item);
        if (!name) continue;
        if (!names.some((n) => normalizeName(n) === normalizeName(name))) names.push(name);
        if (names.length >= 20) break;
      }
    } catch (e) {
      report.libraryError = errorMessage(e);
    }

    if (!names.length) {
      // A brand-new profile has no items; still exercise the whole pipeline
      // with a fixed sample that covers a hit, a miss and both risk lists.
      names = ["Nature", "PLANT PHYSIOLOGY", "J Med Chem", "Aerospace", "CONNECTION SCIENCE", "Journal of Imaginary Studies"];
      report.sampleSource = "builtin";
    } else {
      report.sampleSource = "library";
    }
    report.sampleJournals = names;

    // UI-level checks: the column API can accept a column that the tree never
    // renders, so verify registration, the live tree definition and the cell
    // renderer itself.
    try {
      const win = Zotero.getMainWindow();
      const tree = win && win.ZoteroPane ? win.ZoteroPane.itemsView : null;
      const custom = Zotero.ItemTreeManager.getCustomColumns
        ? Zotero.ItemTreeManager.getCustomColumns().map((c) => c.dataKey)
        : [];
      report.ui = {
        mainWindow: !!win,
        itemTree: !!tree,
        customColumns: custom,
      };

      if (tree && typeof tree._getColumns === "function") {
        const live = (tree._getColumns(false) || [])
          .filter((c) => /impactFactor|jcrQuartile|casDivision|journalWarning/.test(c.dataKey || ""));
        report.ui.treeColumns = live.map((c) => c.dataKey);
        report.ui.columnMeta = live.map((c) => ({
          key: c.dataKey,
          hidden: !!c.hidden,
          width: c.width,
          label: c.label,
        }));
      }

      const warnColumn = (Zotero.ItemTreeManager.getCustomColumns
        ? Zotero.ItemTreeManager.getCustomColumns()
        : []
      ).find((c) => (c.dataKey || "").includes("journalWarning"));
      if (warnColumn && warnColumn.renderCell && win) {
        const cell = warnColumn.renderCell(0, "⚠ 预警·掠夺", warnColumn, false, win.document);
        report.ui.cellRender = {
          tag: cell && cell.tagName,
          text: cell && cell.textContent,
          color: cell && cell.style ? cell.style.color : null,
          className: cell && cell.className,
        };
      }
    } catch (e) {
      report.ui = { error: errorMessage(e) };
    }

    // Menu labels come from Fluent files; an unloaded bundle would render an
    // empty menu item, which no amount of API registration would reveal.
    try {
      const win = Zotero.getMainWindow();
      const doc = win.document;
      const l10n = doc.l10n;
      const values = l10n && l10n.formatValues
        ? await l10n.formatValues([
          { id: "popfish-menu-update" },
          { id: "popfish-column-warning" },
        ])
        : null;
      report.l10n = { hasL10n: !!l10n, values };
    } catch (e) {
      report.l10n = {
        error: errorMessage(e),
        hasL10n: !!(Zotero.getMainWindow().document.l10n),
      };
    }

    if (getPref("popfish.selfTestOnStartup", false)) {
      report.prefPane = await probePrefPane();
      try {
        report.fixes = await verifyFixes();
      } catch (e) {
        report.fixes = { error: errorMessage(e) };
      }
    }

    // Drive the menu callbacks the same way the context menu would, so a menu
    // that registered correctly but renders without a label is caught here.
    try {
      const doc = Zotero.getMainWindow().document;
      const internal = Zotero.MenuManager && Zotero.MenuManager._menuManager;
      const options = internal && internal.getCustomMenuOptions
        ? internal.getCustomMenuOptions("main/library/item")
        : [];
      const entries = [];
      const visit = (list, depth) => {
        for (const m of list) {
          if (m.menuType === "separator") {
            entries.push({ depth, type: "separator" });
            continue;
          }
          const el = doc.createElement(m.menuType === "submenu" ? "menu" : "menuitem");
          const ctx = {
            menuElem: el,
            setEnabled() {},
            setVisible() {},
            setL10nArgs() {},
            setIcon() {},
          };
          try {
            if (m.onShowing) m.onShowing(null, ctx);
          } catch (e) {
            entries.push({ depth, type: m.menuType, error: errorMessage(e) });
            continue;
          }
          entries.push({
            depth,
            type: m.menuType,
            l10nID: m.l10nID,
            label: el.getAttribute("label") || "",
          });
          if (m.menus) visit(m.menus, depth + 1);
        }
      };
      for (const option of options) visit(option.menus || [], 0);
      report.menuEntries = entries;
    } catch (e) {
      report.menuEntries = { error: errorMessage(e) };
    }

    if (names.length) {
      try {
        const result = await ensureData(names);
        report.lookup = {
          requested: result.requested,
          metricsFetched: result.metricsFetched,
          warningsFetched: result.warningsFetched,
          errors: result.errors.map((e) => `${errorCode(e)}: ${errorMessage(e)}`),
        };
      } catch (e) {
        report.lookup = { fatal: errorMessage(e) };
      }

      const fake = (name) => ({ isRegularItem: () => true, getField: () => name });
      report.columns_sample = names.slice(0, 5).map((name) => ({
        journal: name,
        if: columnText("if", fake(name)),
        jcr: columnText("jcr", fake(name)),
        cas: columnText("cas", fake(name)),
        warning: columnText("warning", fake(name)),
        extra: buildExtraLine(name),
      }));
      report.records = names.slice(0, 3).map((name) => ({
        journal: name,
        metrics: state.cache.journals[normalizeName(name)] || null,
        risk: state.cache.warnings[normalizeName(name)] || null,
      }));
    }

    if (!state.stopped) await flushCache();
    log(`SELFTEST ${JSON.stringify(report)}`);
    return report;
  }

  /**
   * Development helper: create a few journal-article records so the columns can
   * be verified visually in a brand-new profile. Only runs when the
   * `popfish.seedTestItems` pref is set, and never duplicates an existing title.
   */
  async function seedTestItems() {
    const seeds = [
      ["Nature", "Demonstration record · Nature"],
      ["Aerospace", "Demonstration record · Aerospace (flagged journal)"],
      ["Journal of Imaginary Studies", "Demonstration record · unindexed journal"],
    ];
    const created = [];
    for (const [journal, title] of seeds) {
      const existing = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
      if (existing.some((it) => publicationOf(it) === journal && it.getField("title") === title)) {
        continue;
      }
      const item = new Zotero.Item("journalArticle");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title", title);
      item.setField("publicationTitle", journal);
      item.setField("date", "2026");
      await item.saveTx();
      created.push(item.id);
    }
    return created;
  }

  /**
   * Open the settings pane, collect the ids that actually rendered, then close
   * it again. Only used by the automated smoke test.
   */
  async function probePrefPane() {
    const out = { registered: false, elements: [], missing: [] };
    try {
      const panes = Zotero.PreferencePanes && Zotero.PreferencePanes.pluginPanes
        ? Zotero.PreferencePanes.pluginPanes
        : [];
      out.registered = panes.some((p) => p.id === "popfish-preferences");
    } catch (e) {
      out.registerError = errorMessage(e);
    }

    try {
      Zotero.Utilities.Internal.openPreferences("popfish-preferences");
      await new Promise((resolve) => setTimeout(resolve, 1800));

      let win = null;
      const e = Services.wm.getEnumerator("zotero:pref");
      while (e.hasMoreElements()) {
        const w = e.getNext();
        if (!w.closed) win = w;
      }
      if (!win) {
        out.windowOpened = false;
        return out;
      }
      out.windowOpened = true;
      const doc = win.document;
      const ids = [
        "bf-api-key", "bf-save-key", "bf-test", "bf-status",
        "bf-col-if", "bf-col-jcr", "bf-col-cas", "bf-col-warning",
        "bf-lazy", "bf-extra", "bf-ttl", "bf-tag",
        "bf-clear", "bf-recheck", "bf-cache-info",
      ];
      for (const id of ids) {
        if (doc.getElementById(id)) out.elements.push(id);
        else out.missing.push(id);
      }
      const keyInput = doc.getElementById("bf-api-key");
      out.keyInputType = keyInput ? keyInput.getAttribute("type") : null;
      const cacheInfo = doc.getElementById("bf-cache-info");
      out.cacheInfoText = cacheInfo ? String(cacheInfo.textContent || "").split("\n")[0] : null;

      // Prove the fragment's onload actually bound handlers: toggle a checkbox
      // through the real event path and watch the stored pref flip.
      const box = doc.getElementById("bf-col-jcr");
      if (box && typeof win.Event === "function") {
        const before = !!box.checked;
        box.checked = !before;
        box.dispatchEvent(new win.Event("command", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 350));
        const flipped = getPref(P.colJCR, true) === !before;
        box.checked = before;
        box.dispatchEvent(new win.Event("command", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 350));
        const restored = getPref(P.colJCR, true) === before;
        out.binding = { before, flipped, restored };
      }

      // saveSettings must return a fresh settings object, not throw.
      const probeDays = 91;
      let saved = null;
      let saveError = null;
      try {
        saved = Zotero.PopFish.api.saveSettings({ cacheDays: probeDays });
      } catch (err) {
        saveError = errorMessage(err);
      }
      out.saveSettings = {
        returned: !!saved,
        cacheDays: saved ? saved.cacheDays : null,
        error: saveError,
      };
      if (saved) Zotero.PopFish.api.saveSettings({ cacheDays: 90 });

      await new Promise((resolve) => {
        try {
          win.close();
        } catch (err) {
          /* ignore */
        }
        setTimeout(resolve, 400);
      });
    } catch (e) {
      out.error = errorMessage(e);
    }
    return out;
  }

  /**
   * Regression checks for the issues raised by the external review. Everything
   * here runs against the live plugin state and restores what it changes.
   */
  async function verifyFixes() {
    const out = {};
    const now = Date.now();

    // 1) Expired records must be queued from the browsing path (M-02).
    const staleName = "__popfish_stale_probe__";
    const staleKey = normalizeName(staleName);
    state.cache.journals[staleKey] = { q: staleName, found: true, jif: "1.0", jif5: "", jcr: "4", cas: "4", ts: now - 200 * 86400000 };
    state.cache.warnings[staleKey] = { q: staleName, warn: false, codes: [], names: [], versions: [], ts: now - 200 * 86400000 };
    const beforePending = state.pending.size;
    columnText("if", { isRegularItem: () => true, getField: () => staleName });
    out.staleQueued = state.pending.size > beforePending || hasInflightFor(staleKey);
    state.pending.delete(staleKey);
    delete state.cache.journals[staleKey];
    delete state.cache.warnings[staleKey];

    // 2) An account block must short-circuit without any request (M-07).
    const requestsBefore = state.stats.requests;
    state.accountBlock = { code: "auth", message: "probe", until: now + 60000 };
    try {
      const blocked = await ensureData(["__popfish_blocked_probe__"]);
      out.accountBlock = {
        blocked: blocked.blocked,
        noRequests: state.stats.requests === requestsBefore,
      };
    } finally {
      state.accountBlock = null;
    }

    // 3) Concurrent requests for the same journal share one in-flight call (M-03).
    const dupName = "Cell";
    const dupKey = normalizeName(dupName);
    const savedMetrics = state.cache.journals[dupKey];
    const savedWarning = state.cache.warnings[dupKey];
    delete state.cache.journals[dupKey];
    delete state.cache.warnings[dupKey];
    const reqBefore = state.stats.requests;
    try {
      await Promise.all([ensureData([dupName]), ensureData([dupName])]);
      out.dedup = { requests: state.stats.requests - reqBefore, expectedAtMost: 2 };
    } catch (e) {
      out.dedup = { error: errorMessage(e) };
    } finally {
      if (savedMetrics) state.cache.journals[dupKey] = savedMetrics;
      if (savedWarning) state.cache.warnings[dupKey] = savedWarning;
    }

    // 4) A missing `is_warning` must never be stored as "not flagged" (M-04).
    const beforeCount = Object.keys(state.cache.warnings).length;
    const bad = absorbWarnings([{ query: "Nature" }], ["Nature"]);
    out.invalidWarning = {
      accepted: bad.accepted,
      invalid: bad.invalid,
      cacheUnchanged: Object.keys(state.cache.warnings).length === beforeCount,
    };

    // 5) force must bypass the per-journal backoff (M-07 second half).
    const backoffName = "Nature";
    state.backoff.set(normalizeName(backoffName), now + 60000);
    try {
      const forced = await ensureData([backoffName], { force: true });
      out.forceBypassesBackoff = forced.skipped === 0;
    } catch (e) {
      out.forceBypassesBackoff = { error: errorMessage(e) };
    } finally {
      state.backoff.delete(normalizeName(backoffName));
    }

    return out;
  }

  // ----------------------------------------------------------------- hooks

  const hooks = {
    async onStartup({ version, rootURI } = {}) {
      state.rootURI = rootURI;
      state.stopped = false;
      state.generation += 1;
      state.lazyBudgetUsed = 0;
      state.cacheLoaded = false;
      state.cacheLoading = null;
      state.cache = {
        schema: CACHE_SCHEMA,
        updated: 0,
        journals: nullMap(),
        warnings: nullMap(),
      };
      state.inflight.clear();
      state.cancellers.clear();
      state.pending.clear();
      log(`starting v${version || PLUGIN_VERSION}`);

      await loadCache();
      registerColumns();
      registerMenus();
      await registerPrefPane(rootURI);
      linkLocalization(Zotero.getMainWindow());

      if (getPref("popfish.selfTestOnStartup", false)) {
        state.selfTestTimer = setTimeout(() => {
          state.selfTestTimer = null;
          if (state.stopped) return;
          selfTest().catch((e) => log(`startup self-test failed: ${errorMessage(e)}`));
        }, 4000);
        return;
      }

      state.onboardTimer = setTimeout(() => {
        state.onboardTimer = null;
        onboard();
      }, 6000);
    },

    async onMainWindowLoad(window) {
      // Fluent keeps a per-document bundle list, so every window needs the
      // plugin's .ftl files linked in explicitly.
      linkLocalization(window);
    },

    async onMainWindowUnload(window) {
      removeL10nLinks(window && window.document);
    },

    /**
     * Stop new work, let outstanding requests settle (their results are already
     * ineligible because the generation moved), then make sure the newest
     * snapshot reached the disk. Returns a promise the host can await.
     */
    async onShutdown({ appShutdown = false } = {}) {
      state.stopped = true;
      state.generation += 1;

      for (const key of ["pendingTimer", "refreshTimer", "onboardTimer", "saveTimer", "selfTestTimer"]) {
        if (state[key]) {
          clearTimeout(state[key]);
          state[key] = null;
        }
      }
      state.pending.clear();
      // Ask every live HTTP request to abort. This stops us from waiting for
      // the response; it does not reverse a charge the server already made.
      cancelInflight();

      const inflight = Array.from(new Set(state.inflight.values()));
      if (inflight.length) {
        try {
          await Promise.race([
            Promise.all(inflight.map((p) => p.then(() => null).catch(() => null))),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
        } catch (e) {
          /* never block shutdown on a stuck request */
        }
      }
      state.inflight.clear();

      if (!appShutdown) {
        unregisterColumns();
        unregisterMenus();
        removeL10nLinks(null);
      }

      try {
        await flushCache();
      } catch (e) {
        log(`final cache flush failed: ${errorMessage(e)}`);
      }

      log(appShutdown ? "stopped (application shutdown)" : "stopped");
    },
  };

  function onboard() {
    if (state.stopped || getPref(P.welcome, false)) return;
    setPrefSafe(P.welcome, true);

    if (hasApiKey()) {
      notify(
        PLUGIN_NAME,
        [
          "插件已就绪，四个期刊列已添加到条目列表。",
          "不需要某些列时，可在表头右键 → 列选择器中隐藏；宽度也可直接拖动。",
        ],
        10000,
      );
    } else {
      notify(PLUGIN_NAME, ["首次使用需要填写文献泡泡 API Key", "已为你打开设置面板"], 9000);
      openPreferences();
    }
  }

  // ------------------------------------------------------------- public api

  Zotero.PopFish = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    hooks,
    api: {
      getSettings: () => ({
        apiKeySet: hasApiKey(),
        lazyLookup: getPref(P.lazyLookup, false),
        lazyBudget: lazyBudget(),
        writeExtra: getPref(P.writeExtra, true),
        extraTag: extraTag(),
        cacheDays: Number(getPref(P.cacheDays, 90)) || 90,
        columns: {
          if: getPref(P.colIF, true),
          jcr: getPref(P.colJCR, true),
          cas: getPref(P.colCAS, true),
          warning: getPref(P.colWarn, true),
        },
      }),
      // A method (not an arrow) so `this` really is the api object: the review
      // caught the arrow form throwing on `return this.getSettings()`.
      saveSettings(patch = {}) {
        if (state.stopped) throw new Error("插件已停止，未写入设置");
        const failures = [];
        const write = (field, pref, value) => {
          try {
            setPref(pref, value);
            return true;
          } catch (e) {
            failures.push({ field, message: errorMessage(e) });
            return false;
          }
        };
        const columnsTouched = !!(patch.columns && typeof patch.columns === "object");
        let columnsSaved = false;

        if (typeof patch.apiKey === "string") {
          // A credential change starts a new generation: in-flight requests
          // authenticated with the old key can no longer write a result or an
          // account error into the new state.
          state.generation += 1;
          cancelInflight();
          const keySaved = write("API Key", P.apiKey, patch.apiKey.trim());
          if (keySaved) {
            // Only a durable new key may lift an auth/quota lock.
            state.accountBlock = null;
            state.backoff.clear();
          }
        }
        if (typeof patch.lazyLookup === "boolean") {
          const saved = write("浏览时自动补全", P.lazyLookup, patch.lazyLookup);
          // Turning automatic lookups off must also drop work that has been
          // queued but not sent; the debounce timer would otherwise fire soon
          // after the user opted out.
          if (saved && patch.lazyLookup === false) clearPendingQueue();
        }
        if (typeof patch.writeExtra === "boolean") write("写入 Extra", P.writeExtra, patch.writeExtra);
        if (typeof patch.extraTag === "string" && patch.extraTag.trim()) {
          write("Extra 标签", P.extraTag, patch.extraTag.trim());
        }
        if (patch.cacheDays != null) {
          const days = Math.max(1, Math.min(3650, Number(patch.cacheDays) || 90));
          write("缓存有效期", P.cacheDays, days);
        }
        if (patch.lazyBudget != null) {
          const budget = Math.max(0, Math.min(MAX_LAZY_BUDGET, Math.floor(Number(patch.lazyBudget))));
          if (Number.isFinite(budget)) write("自动查询预算", P.lazyBudget, budget);
        }
        if (columnsTouched) {
          const setColumn = (field, pref, value) => {
            if (write(field, pref, !!value)) columnsSaved = true;
          };
          if ("if" in patch.columns) setColumn("影响因子列", P.colIF, patch.columns.if);
          if ("jcr" in patch.columns) setColumn("JCR 分区列", P.colJCR, patch.columns.jcr);
          if ("cas" in patch.columns) setColumn("中科院分区列", P.colCAS, patch.columns.cas);
          if ("warning" in patch.columns) setColumn("期刊预警列", P.colWarn, patch.columns.warning);
          // Only column visibility needs a full tree rebuild; a TTL change does not.
          if (columnsSaved) rebuildFromSettings();
        }
        if (failures.length) {
          const names = failures.map((f) => f.field).join("、");
          const err = new Error(`设置未全部保存：${names}`);
          err.failures = failures;
          err.settings = this.getSettings();
          throw err;
        }
        return this.getSettings();
      },
      cacheStats,
      testConnection,
      clearCache,
      rebuildColumns: rebuildFromSettings,
      updateSelected,
      scanCurrentView,
      copySnapshot,
      scanCollection,
      scanLibrary,
      openPreferences,
      refresh: refreshColumnsSoon,
      hasApiKey,
      selfTest,
    },
  };
}
