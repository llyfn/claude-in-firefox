const COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red"];
const KEY = "claudeSession";
const STATUS_SUFFIX = { new: "", busy: " · working", idle: "" };
export const NO_SESSION_MESSAGE = "This session has no window yet. Call tabs_context with createIfEmpty: true first.";
export const NEEDS_GROUPS_MESSAGE = "Claude sessions in this browser need tab groups. Set browser.tabs.groups.enabled to true in about:config.";

// A grouped session lives in a tab group of the user's window and owns only the tabs in that group, plus its popup windows.
export function createSessions(api, { onLoaded = () => {}, grouped = false } = {}) {
  const records = new Map();
  const creating = new Map();
  const recovering = new Map();
  let opening = Promise.resolve();
  let nextColor = 0;

  const tagOf = (sessionId) => `Claude · ${sessionId.slice(0, 4)}`;
  const labelOf = (rec) => `${tagOf(rec.id)}${rec.stopped ? " · stopped" : STATUS_SUFFIX[rec.status]}`;

  // Firefox may leave the tab group APIs undefined instead of rejecting when groups are disabled.
  const groupCall = (fn) => Promise.resolve().then(fn);

  function newRecord(sessionId) {
    return { id: sessionId, main: null, windows: new Set(), grouped: false, groupId: null, color: null, status: "new", stopped: false, known: null };
  }

  const owns = (rec, tab) => rec.windows.has(tab.windowId) && !(rec.grouped && tab.windowId === rec.main && tab.groupId !== rec.groupId);

  function register(rec) {
    rec.color ??= COLORS[nextColor++ % COLORS.length];
    records.set(rec.id, rec);
  }

  async function applyLabel(rec) {
    const label = labelOf(rec);
    if (!rec.grouped) await api.windows.update(rec.main, { titlePreface: `${label} — ` }).catch(() => {});
    if (rec.groupId != null) await groupCall(() => api.tabGroups.update(rec.groupId, { title: label, color: rec.color })).catch(() => {});
  }

  // Several grouped sessions can share the user's window, so each keeps its own value there.
  const keyOf = (rec, windowId) => (rec.grouped && windowId === rec.main ? `${KEY}:${rec.id}` : KEY);
  const persist = (rec, windowId) => api.sessions.setWindowValue(windowId, keyOf(rec, windowId), { sessionId: rec.id, role: windowId === rec.main ? "main" : "popup", stopped: rec.stopped, groupId: rec.groupId });

  async function tabsOf(rec) {
    const lists = await Promise.all([...rec.windows].map((windowId) => api.tabs.query({ windowId })));
    return lists.flat().filter((tab) => owns(rec, tab));
  }

  // Resolves to false when the tabs could not be grouped. A group whose tabs all closed is gone, so a new one replaces it;
  // a group that still exists is kept, since replacing it would leave the session's other tabs behind.
  async function joinGroup(rec, tabIds) {
    if (rec.groupId != null) {
      if (await groupCall(() => api.tabs.group({ groupId: rec.groupId, tabIds })).then(() => true, () => false)) return true;
      if (await groupCall(() => api.tabGroups.get(rec.groupId)).then(() => true, () => false)) return false;
    }
    const groupId = await groupCall(() => api.tabs.group({ tabIds, createProperties: { windowId: rec.main } })).catch(() => null);
    if (groupId == null) return false;
    rec.groupId = groupId;
    // A session still being created is labelled and saved once it is registered.
    if (records.get(rec.id) === rec) {
      await persist(rec, rec.main).catch(() => {});
      await applyLabel(rec);
    }
    return true;
  }

  // Window values survive add-on reloads and Firefox restarts, unlike this background page's memory.
  async function scan(sessionId) {
    const rec = newRecord(sessionId);
    let savedGroupId = null;
    for (const win of await api.windows.getAll()) {
      for (const key of [KEY, `${KEY}:${sessionId}`]) {
        const value = await api.sessions.getWindowValue(win.id, key).catch(() => undefined);
        if (value?.sessionId !== sessionId) continue;
        rec.windows.add(win.id);
        if (value.role === "main") {
          rec.main = win.id;
          rec.grouped = key !== KEY;
          savedGroupId = value.groupId ?? null;
        }
        if (value.stopped) rec.stopped = true;
      }
    }
    if (rec.main == null) return null;
    const groups = await groupCall(() => api.tabGroups.query({ windowId: rec.main })).catch(() => []);
    // The title only holds part of the session ID, so the saved group ID comes first.
    const group = groups.find((g) => g.id === savedGroupId) ?? groups.find((g) => g.title === tagOf(sessionId) || g.title?.startsWith(`${tagOf(sessionId)} · `));
    rec.groupId = group?.id ?? null;
    rec.color = group?.color ?? null;
    return rec;
  }

  async function recover(sessionId) {
    const rec = await scan(sessionId);
    if (!rec) return null;
    if (records.has(sessionId)) return records.get(sessionId);
    register(rec);
    onLoaded(sessionId);
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

  // Firefox ignores focused: false and focuses the new window, so the user's window gets focus back.
  // Windows open one at a time, so no session mistakes another session's new window for the user's.
  function openWindow() {
    const opened = opening.then(async () => {
      const previous = await api.windows.getLastFocused().catch(() => null);
      const win = await api.windows.create({ url: "about:blank", focused: false });
      if (previous?.focused) await api.windows.update(previous.id, { focused: true }).catch(() => {});
      return win;
    });
    opening = opened.catch(() => {});
    return opened;
  }

  async function create(sessionId) {
    const rec = newRecord(sessionId);
    rec.grouped = await grouped;
    let tabIds;
    if (rec.grouped) {
      const popupOfSession = (windowId) => [...records.values()].some((r) => r.main !== windowId && r.windows.has(windowId));
      let win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
      if (popupOfSession(win.id)) win = (await api.windows.getAll({ windowTypes: ["normal"] })).find((w) => !popupOfSession(w.id));
      if (!win) throw new Error("There is no window for this session's tab: every open window belongs to another Claude session.");
      const tab = await api.tabs.create({ windowId: win.id, url: "about:blank", active: false });
      rec.main = win.id;
      tabIds = [tab.id];
    } else {
      const win = await openWindow();
      rec.main = win.id;
      tabIds = win.tabs.map((t) => t.id);
    }
    rec.windows.add(rec.main);
    if (!(await joinGroup(rec, tabIds)) && rec.grouped) {
      await api.tabs.remove(tabIds).catch(() => {});
      throw new Error(NEEDS_GROUPS_MESSAGE);
    }
    register(rec);
    await persist(rec, rec.main).catch(() => {});
    await applyLabel(rec);
    onLoaded(sessionId);
    return rec;
  }

  function recordOfTab(tab) {
    for (const rec of records.values()) if (owns(rec, tab)) return rec;
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
      const tab = await api.tabs.create({ windowId: rec.main, url: "about:blank", active: !rec.grouped });
      if (!(await joinGroup(rec, [tab.id])) && rec.grouped) {
        await api.tabs.remove(tab.id).catch(() => {});
        throw new Error("The new tab could not join this session's tab group.");
      }
      return tab;
    },

    async ownedTab(sessionId, tabId) {
      const rec = await find(sessionId);
      if (!rec) throw new Error(NO_SESSION_MESSAGE);
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (tab && owns(rec, tab)) return tab;
      const valid = (await tabsOf(rec)).map((t) => t.id);
      throw new Error(`Tab ${tabId} is not in this session's ${rec.grouped ? "tab group" : "window"}. Valid tab IDs: ${valid.join(", ") || "none"}`);
    },

    // A grouped session's tabs sit in the user's window, where switching tabs would take the user's view.
    async activate(tab) {
      if (!tab.active && !recordOfTab(tab)?.grouped) await api.tabs.update(tab.id, { active: true }).catch(() => {});
    },

    // A session page that opens a tab keeps it in the session's window and group; one that opens a popup
    // gets a fresh single-tab window, which joins the session. Tabs in other windows never do.
    async adoptOpened(tab) {
      if (tab.openerTabId == null) return;
      const opener = await api.tabs.get(tab.openerTabId).catch(() => null);
      const rec = opener && recordOfTab(opener);
      if (!rec) return;
      if (rec.windows.has(tab.windowId)) {
        if (tab.windowId === rec.main) await joinGroup(rec, [tab.id]);
        return;
      }
      if ((await api.tabs.query({ windowId: tab.windowId })).length !== 1) return;
      rec.windows.add(tab.windowId);
      await persist(rec, tab.windowId).catch(() => {});
    },

    // Only sessions a call has loaded count, so windows restored from a session that ended without session_closed stay inert.
    async sessionOfTab(tab) {
      return recordOfTab(tab)?.id ?? null;
    },

    async sharesUserWindow(tab) {
      const rec = recordOfTab(tab);
      return Boolean(rec?.grouped) && tab.windowId === rec.main;
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

    // Resolves to the tabs of popup windows that left the session with its main window.
    async windowRemoved(windowId) {
      const popups = [];
      for (const rec of [...records.values()]) {
        if (rec.main === windowId) {
          records.delete(rec.id);
          for (const id of rec.windows) if (id !== windowId) popups.push(id);
        } else rec.windows.delete(windowId);
      }
      for (const id of popups) api.sessions.removeWindowValue(id, KEY).catch(() => {});
      const lists = await Promise.all(popups.map((id) => api.tabs.query({ windowId: id }).catch(() => [])));
      return lists.flat();
    },

    async close(sessionId) {
      await Promise.all([creating.get(sessionId), recovering.get(sessionId)].map((pending) => pending?.catch(() => {})));
      const rec = records.get(sessionId) ?? (await scan(sessionId));
      if (!rec) return [];
      const tabs = await tabsOf(rec).catch(() => []);
      for (const windowId of rec.windows) await api.sessions.removeWindowValue(windowId, keyOf(rec, windowId)).catch(() => {});
      records.delete(sessionId);
      if (rec.grouped) {
        const inGroup = tabs.filter((t) => t.windowId === rec.main).map((t) => t.id);
        if (inGroup.length) await groupCall(() => api.tabs.ungroup(inGroup)).catch(() => {});
      } else {
        await api.windows.update(rec.main, { titlePreface: "" }).catch(() => {});
        if (rec.groupId != null) await groupCall(() => api.tabGroups.update(rec.groupId, { title: "" })).catch(() => {});
      }
      return tabs;
    },
  };
}
