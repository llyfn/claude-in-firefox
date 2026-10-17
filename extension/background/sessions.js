const COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red"];
const KEY = "claudeSession";
const STATUS_PREFIX = { new: "", busy: "⌛ ", idle: "✅ " };
export const NO_SESSION_MESSAGE = "This session has no window yet. Call tabs_context with createIfEmpty: true first.";

export function createSessions(api) {
  const records = new Map();
  const creating = new Map();
  const recovering = new Map();
  let nextColor = 0;

  const tagOf = (sessionId) => `Claude · ${sessionId.slice(0, 8)}`;
  const labelOf = (rec) => `${rec.stopped ? "⏸ " : STATUS_PREFIX[rec.status]}${tagOf(rec.id)}`;

  // Firefox may leave the tab group APIs undefined instead of rejecting when groups are disabled.
  const groupCall = (fn) => Promise.resolve().then(fn);

  function newRecord(sessionId) {
    return { id: sessionId, main: null, windows: new Set(), groupId: null, color: null, status: "new", stopped: false, known: null };
  }

  function register(rec) {
    rec.color ??= COLORS[nextColor++ % COLORS.length];
    records.set(rec.id, rec);
  }

  async function applyLabel(rec) {
    const label = labelOf(rec);
    await api.windows.update(rec.main, { titlePreface: `${label} — ` }).catch(() => {});
    if (rec.groupId != null) await groupCall(() => api.tabGroups.update(rec.groupId, { title: label, color: rec.color })).catch(() => {});
  }

  const persist = (rec, windowId) => api.sessions.setWindowValue(windowId, KEY, { sessionId: rec.id, role: windowId === rec.main ? "main" : "popup", stopped: rec.stopped });

  async function tabsOf(rec) {
    const lists = await Promise.all([...rec.windows].map((windowId) => api.tabs.query({ windowId })));
    return lists.flat();
  }

  // Window values survive add-on reloads and Firefox restarts, unlike this background page's memory.
  async function recover(sessionId) {
    const rec = newRecord(sessionId);
    for (const win of await api.windows.getAll()) {
      const value = await api.sessions.getWindowValue(win.id, KEY).catch(() => undefined);
      if (value?.sessionId !== sessionId) continue;
      rec.windows.add(win.id);
      if (value.role === "main") rec.main = win.id;
      if (value.stopped) rec.stopped = true;
    }
    if (rec.main == null) return null;
    const groups = await groupCall(() => api.tabGroups.query({ windowId: rec.main })).catch(() => []);
    const group = groups.find((g) => g.title?.endsWith(tagOf(sessionId)));
    rec.groupId = group?.id ?? null;
    rec.color = group?.color ?? null;
    if (records.has(sessionId)) return records.get(sessionId);
    register(rec);
    return rec;
  }

  async function find(sessionId) {
    const rec = records.get(sessionId);
    if (!rec) {
      if (!recovering.has(sessionId)) recovering.set(sessionId, recover(sessionId).finally(() => recovering.delete(sessionId)));
      return recovering.get(sessionId);
    }
    if (await api.windows.get(rec.main).then(() => true, () => false)) return rec;
    records.delete(sessionId);
    return null;
  }

  async function create(sessionId) {
    const previous = await api.windows.getLastFocused().catch(() => null);
    const win = await api.windows.create({ url: "about:blank", focused: false });
    // Firefox ignores focused: false and focuses the new window, so the user's window gets focus back.
    if (previous?.focused) await api.windows.update(previous.id, { focused: true }).catch(() => {});
    const rec = newRecord(sessionId);
    rec.main = win.id;
    rec.windows.add(win.id);
    register(rec);
    await persist(rec, win.id).catch(() => {});
    rec.groupId = await groupCall(() => api.tabs.group({ tabIds: win.tabs.map((t) => t.id), createProperties: { windowId: win.id } })).catch(() => null);
    await applyLabel(rec);
    return rec;
  }

  function recordOfWindow(windowId) {
    for (const rec of records.values()) if (rec.windows.has(windowId)) return rec;
    return null;
  }

  return {
    async context(sessionId, { createIfEmpty = false } = {}) {
      let rec = await find(sessionId);
      if (!rec) {
        if (!createIfEmpty) return null;
        rec = records.get(sessionId);
      }
      if (!rec) {
        if (!creating.has(sessionId)) creating.set(sessionId, create(sessionId).finally(() => creating.delete(sessionId)));
        rec = await creating.get(sessionId);
      }
      const tabs = await tabsOf(rec);
      rec.known = new Set(tabs.map((t) => t.id));
      return { availableTabs: tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url })), windowId: rec.main };
    },

    async createTab(sessionId) {
      const rec = await find(sessionId);
      if (!rec) throw new Error(NO_SESSION_MESSAGE);
      const tab = await api.tabs.create({ windowId: rec.main, url: "about:blank", active: true });
      if (rec.groupId != null) await groupCall(() => api.tabs.group({ groupId: rec.groupId, tabIds: [tab.id] })).catch(() => {});
      return tab;
    },

    async ownedTab(sessionId, tabId) {
      const rec = await find(sessionId);
      if (!rec) throw new Error(NO_SESSION_MESSAGE);
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (tab && rec.windows.has(tab.windowId)) return tab;
      const valid = (await tabsOf(rec)).map((t) => t.id);
      throw new Error(`Tab ${tabId} is not in this session's window. Valid tab IDs: ${valid.join(", ") || "none"}`);
    },

    async activate(tab) {
      if (!tab.active) await api.tabs.update(tab.id, { active: true }).catch(() => {});
    },

    // A page in a session window that opens a tab keeps it in that window; one that opens a popup
    // gets a fresh single-tab window, which joins the session. Tabs in other windows never do.
    async adoptOpened(tab) {
      if (tab.openerTabId == null) return;
      const opener = await api.tabs.get(tab.openerTabId).catch(() => null);
      const rec = opener && recordOfWindow(opener.windowId);
      if (!rec) return;
      if (rec.windows.has(tab.windowId)) {
        if (tab.windowId === rec.main && rec.groupId != null) await groupCall(() => api.tabs.group({ groupId: rec.groupId, tabIds: [tab.id] })).catch(() => {});
        return;
      }
      if ((await api.tabs.query({ windowId: tab.windowId })).length !== 1) return;
      rec.windows.add(tab.windowId);
      await persist(rec, tab.windowId).catch(() => {});
    },

    async sessionOfTab(tab) {
      const rec = recordOfWindow(tab.windowId);
      if (rec) return rec.id;
      const value = await api.sessions.getWindowValue(tab.windowId, KEY).catch(() => undefined);
      return value?.sessionId && (await find(value.sessionId)) ? value.sessionId : null;
    },

    async sessionTabs(sessionId) {
      const rec = await find(sessionId);
      return rec ? tabsOf(rec) : [];
    },

    async isStopped(sessionId) {
      return (await find(sessionId))?.stopped ?? false;
    },

    async setStopped(sessionId, stopped) {
      const rec = await find(sessionId);
      if (!rec) return;
      rec.stopped = stopped;
      if (!stopped) rec.status = "idle";
      for (const windowId of rec.windows) await persist(rec, windowId).catch(() => {});
      await applyLabel(rec);
    },

    async setStatus(sessionId, status) {
      const rec = records.get(sessionId);
      if (!rec || rec.status === status) return;
      rec.status = status;
      await applyLabel(rec);
    },

    async tabChanges(sessionId) {
      const rec = records.get(sessionId);
      if (!rec) return "";
      const tabs = await tabsOf(rec);
      const before = rec.known ?? new Set(tabs.map((t) => t.id));
      rec.known = new Set(tabs.map((t) => t.id));
      const opened = tabs.filter((t) => !before.has(t.id)).map((t) => `opened ${t.id} ${JSON.stringify(t.title ?? "")} ${t.url}`);
      const closed = [...before].filter((id) => !rec.known.has(id)).map((id) => `closed ${id}`);
      return opened.length || closed.length ? `Tabs changed: ${[...opened, ...closed].join("; ")}` : "";
    },

    windowRemoved(windowId) {
      for (const rec of [...records.values()]) {
        if (rec.main === windowId) {
          records.delete(rec.id);
          for (const id of rec.windows) if (id !== windowId) api.sessions.removeWindowValue(id, KEY).catch(() => {});
        } else rec.windows.delete(windowId);
      }
    },

    async close(sessionId) {
      const rec = records.get(sessionId);
      records.delete(sessionId);
      if (rec) for (const windowId of rec.windows) await api.sessions.removeWindowValue(windowId, KEY).catch(() => {});
    },
  };
}
