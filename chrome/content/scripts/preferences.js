/* eslint-disable no-undef */
/**
 * Settings pane logic for Pop-Fish.
 *
 * Loaded by Zotero.PreferencePanes.register() into the preferences window.
 * Everything is written through Zotero.PopFish.api so the plugin keeps a
 * single source of truth for prefs and column registration.
 */
{
  let initialised = false;

  const $ = (id) => document.getElementById(id);

  function api() {
    return typeof Zotero !== "undefined" && Zotero.PopFish ? Zotero.PopFish.api : null;
  }

  function setStatus(text, kind) {
    const el = $("bf-status");
    if (!el) return;
    el.textContent = text;
    if (kind === "error") el.style.color = "#c0392b";
    else if (kind === "ok") el.style.color = "#2f8f4e";
    else el.style.color = "";
  }

  function describeUsage(usage) {
    if (!usage) return "";
    const source = usage.source === "free" ? "免费额度" : "付费额度";
    const parts = [`计费来源 ${source}`];
    if (usage.free_used != null) parts.push(`今日免费已用 ${usage.free_used} 次`);
    if (usage.remaining != null) parts.push(`剩余 ${usage.remaining}`);
    return parts.join(" · ");
  }

  function renderCacheInfo() {
    const handle = api();
    const el = $("bf-cache-info");
    if (!handle || !el) return;

    const stats = handle.cacheStats();
    const lines = [
      `已缓存 ${stats.journals} 种期刊指标 / ${stats.warnings} 条风险查询`,
      `本地缓存：${stats.path}`,
      `本次会话已发起 ${stats.requests} 次接口请求`,
      `自动查询预算：已用 ${stats.lazyBudgetUsed} / ${stats.lazyBudget} 个期刊（剩余 ${stats.lazyBudgetRemaining}）`,
    ];
    if (stats.updated) {
      lines.splice(1, 0, `最近写入：${new Date(stats.updated).toLocaleString()}`);
    }
    if (stats.lastUsage) {
      lines.push(`最近一次响应：${describeUsage(stats.lastUsage)}`);
    }
    if (stats.lastError) {
      lines.push(`最近一次失败：${stats.lastError.message}`);
    }
    if (stats.accountBlock) {
      lines.push(`账户已暂停自动查询：${stats.accountBlock.code} — ${stats.accountBlock.message}`);
    }
    el.textContent = lines.join("\n");
    el.style.whiteSpace = "pre-line";
  }

  function loadSettings() {
    const handle = api();
    if (!handle) {
      setStatus("插件尚未加载完成，请稍后重新打开此面板。", "error");
      return;
    }

    const settings = handle.getSettings();
    const keyInput = $("bf-api-key");
    if (keyInput) {
      keyInput.value = "";
      keyInput.placeholder = settings.apiKeySet ? "已保存 · 留空表示不修改" : "pp_...";
    }
    $("bf-lazy").checked = settings.lazyLookup;
    $("bf-budget").value = settings.lazyBudget;
    $("bf-extra").checked = settings.writeExtra;
    $("bf-ttl").value = settings.cacheDays;
    $("bf-tag").value = settings.extraTag;
    $("bf-col-if").checked = settings.columns.if;
    $("bf-col-jcr").checked = settings.columns.jcr;
    $("bf-col-cas").checked = settings.columns.cas;
    $("bf-col-warning").checked = settings.columns.warning;

    setStatus(settings.apiKeySet ? "API Key 已保存。首次使用请点击「填充当前列表」获取文献的期刊数据。" : "尚未设置 API Key。", settings.apiKeySet ? "ok" : null);
    renderCacheInfo();
  }

  /**
   * Every write goes through here so a failure is visible in the pane instead
   * of dying as an unhandled rejection inside a change handler.
   */
  function savePatch(patch) {
    const handle = api();
    if (!handle) {
      setStatus("插件尚未加载完成，改动未保存。", "error");
      return false;
    }
    try {
      handle.saveSettings(patch);
      renderCacheInfo();
      return true;
    } catch (e) {
      setStatus(`保存失败：${(e && e.message) || e}`, "error");
      try {
        Zotero.logError(e);
      } catch (inner) {
        /* nothing else we can do */
      }
      return false;
    }
  }

  function bind() {
    $("bf-toggle-key").addEventListener("click", () => {
      const input = $("bf-api-key");
      const button = $("bf-toggle-key");
      const showing = input.getAttribute("type") === "text";
      input.setAttribute("type", showing ? "password" : "text");
      button.textContent = showing ? "显示" : "隐藏";
    });

    $("bf-save-key").addEventListener("click", () => {
      const value = ($("bf-api-key").value || "").trim();
      if (!value) {
        setStatus("输入框为空，已保留原有 Key。", null);
        return;
      }
      // Keep the typed key in the field when the host refuses the write; the
      // old pane cleared it and then claimed success.
      if (!savePatch({ apiKey: value })) return;
      $("bf-api-key").value = "";
      $("bf-api-key").placeholder = "已保存 · 留空表示不修改";
      setStatus("已保存。建议点「测试连接」确认可用。", "ok");
    });

    $("bf-clear-key").addEventListener("click", () => {
      if (!savePatch({ apiKey: "" })) return;
      $("bf-api-key").value = "";
      $("bf-api-key").placeholder = "pp_...";
      setStatus("API Key 已清除；后续查询不会发起。", "ok");
    });

    $("bf-test").addEventListener("click", async () => {
      const handle = api();
      if (!handle) return;
      const button = $("bf-test");
      // A connection probe is a billable request. Disable the button before
      // awaiting so a double click cannot spend two requests.
      if (button.disabled || $("bf-fill-current").disabled) return;
      button.disabled = true;
      const keyControls = ["bf-api-key", "bf-save-key", "bf-clear-key", "bf-fill-current"];
      for (const id of keyControls) $(id).disabled = true;
      const typed = ($("bf-api-key").value || "").trim();
      const key = typed || undefined;
      setStatus("正在连接期刊服务…（会消耗 1 次请求）", null);
      try {
        const result = await handle.testConnection(key);
        const bits = [`连接正常 · ${result.latencyMs} ms`];
        if (typed) {
          // Persist only a successfully tested key. A green test used to leave
          // this transient input unsaved, so later list queries had no key.
          if (!savePatch({ apiKey: typed })) return;
          $("bf-api-key").value = "";
          $("bf-api-key").placeholder = "已保存 · 留空表示不修改";
          bits.push("Key 已保存");
        }
        if (result.sample) {
          const s = result.sample;
          bits.push(`样例 Nature：JIF ${s.JIF} / JCR Q${s.Q} / 中科院 ${s.N} 区`);
        }
        const usage = describeUsage(result.usage);
        if (usage) bits.push(usage);
        bits.push("检测只查询 Nature，不会自动扫描文库；请点击「填充当前列表」，确认请求数后显示文献指标，无需重启");
        renderCacheInfo();
        setStatus(bits.join(" · "), "ok");
      } catch (e) {
        setStatus(`连接失败：${e.message || e}`, "error");
      } finally {
        button.disabled = false;
        for (const id of keyControls) $(id).disabled = false;
      }
    });

    $("bf-fill-current").addEventListener("click", async () => {
      const handle = api();
      const button = $("bf-fill-current");
      if (!handle || button.disabled || $("bf-test").disabled) return;
      if (($("bf-api-key").value || "").trim()) {
        setStatus("输入框中有未保存的 Key，请先点击「测试连接」或「保存」。", "error");
        return;
      }
      button.disabled = true;
      setStatus("正在检查当前列表，将在查询前确认预计请求数…", null);
      try {
        const result = await handle.scanCurrentView();
        if (!result || result.aborted) {
          setStatus("查询已中止，请重新打开设置后再试。", "error");
        } else if (result.cancelled) {
          setStatus("已取消填充，未发起查询，未写入 Extra。", null);
        } else if (result.blocked === "no-view") {
          setStatus("请先回到 Zotero 文献列表，选择要填充的文库或分类。", "error");
        } else if (result.blocked === "no-journals") {
          setStatus("当前列表没有带期刊名的条目，请检查文献的「刊名」字段。", "error");
        } else if (result.blocked || result.missing || result.invalid || result.incomplete || (result.errors && result.errors.length)) {
          setStatus(`填充未全部完成：${(result.errors && result.errors[0] && result.errors[0].message) || result.blocked || "服务端结果缺失或格式无效，请稍后重试"}。请查看下方最近一次失败。`, "error");
        } else {
          setStatus(`已填充 ${result.items} 篇文献 / ${result.journals} 种期刊，列表已刷新，无需重启。`, "ok");
        }
        renderCacheInfo();
      } catch (e) {
        setStatus(`填充失败：${e.message || e}`, "error");
      } finally {
        button.disabled = false;
      }
    });

    for (const [id, key] of [
      ["bf-lazy", "lazyLookup"],
      ["bf-extra", "writeExtra"],
    ]) {
      $(id).addEventListener("command", (event) => {
        savePatch({ [key]: !!event.target.checked });
      });
    }

    for (const [id, key] of [
      ["bf-col-if", "if"],
      ["bf-col-jcr", "jcr"],
      ["bf-col-cas", "cas"],
      ["bf-col-warning", "warning"],
    ]) {
      $(id).addEventListener("command", (event) => {
        savePatch({ columns: { [key]: !!event.target.checked } });
      });
    }

    $("bf-ttl").addEventListener("change", (event) => {
      savePatch({ cacheDays: event.target.value });
    });

    $("bf-budget").addEventListener("change", (event) => {
      savePatch({ lazyBudget: event.target.value });
    });

    $("bf-tag").addEventListener("change", (event) => {
      savePatch({ extraTag: event.target.value });
    });

    $("bf-clear").addEventListener("click", async () => {
      const handle = api();
      if (!handle) return;
      const button = $("bf-clear");
      if (button.disabled) return;
      button.disabled = true;
      try {
        const result = await handle.clearCache();
        if (result && result.ok === false) {
          setStatus(`清除缓存失败：${result.error || "磁盘写入失败"}`, "error");
        } else {
          setStatus("缓存已清除。", null);
        }
        renderCacheInfo();
      } catch (e) {
        setStatus(`清除缓存失败：${(e && e.message) || e}`, "error");
      } finally {
        button.disabled = false;
      }
    });

    $("bf-recheck").addEventListener("click", () => {
      const handle = api();
      if (!handle) return;
      handle.scanCollection();
    });
  }

  function init() {
    if (initialised) return;
    if (!$("popfish-prefpane")) return;
    initialised = true;
    try {
      loadSettings();
      bind();
    } catch (e) {
      setStatus(`面板初始化失败：${e.message}`, "error");
      Zotero.logError(e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.PopFish_Preferences = { init, reload: loadSettings };
}
