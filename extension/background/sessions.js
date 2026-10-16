const COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red"];
export const NO_GROUP_MESSAGE = "This session has no tab group yet. Call tabs_context with createIfEmpty: true first.";

export function createSessions(api) {
  const groups = new Map();
  let nextColor = 0;

  async function liveGroup(sessionId) {
    const groupId = groups.get(sessionId);
    if (groupId == null) return null;
    try {
      await api.tabGroups.get(groupId);
      return groupId;
    } catch {
      groups.delete(sessionId);
      return null;
    }
  }

  const creating = new Map();

  async function createGroup(sessionId) {
    const tab = await newBlankTab();
    const groupId = await api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await api.tabGroups.update(groupId, { title: `Claude · ${sessionId.slice(0, 4)}`, color: COLORS[nextColor++ % COLORS.length] });
    groups.set(sessionId, groupId);
    return groupId;
  }

  async function newBlankTab() {
    let win = null;
    try {
      win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
    } catch {
      // No normal window is open (possible on macOS); a new one is created below.
    }
    if (win) return api.tabs.create({ windowId: win.id, url: "about:blank", active: false });
    const created = await api.windows.create({ url: "about:blank" });
    return created.tabs[0];
  }

  return {
    async context(sessionId, { createIfEmpty = false } = {}) {
      let groupId = await liveGroup(sessionId);
      if (groupId == null) {
        if (!createIfEmpty) return null;
        if (!creating.has(sessionId)) {
          creating.set(sessionId, createGroup(sessionId).finally(() => creating.delete(sessionId)));
        }
        groupId = await creating.get(sessionId);
      }
      const tabs = await api.tabs.query({ groupId });
      return { availableTabs: tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url })), tabGroupId: groupId };
    },

    async createTab(sessionId) {
      const groupId = await liveGroup(sessionId);
      if (groupId == null) throw new Error(NO_GROUP_MESSAGE);
      const [member] = await api.tabs.query({ groupId });
      const tab = await api.tabs.create({ windowId: member.windowId, url: "about:blank", active: false });
      await api.tabs.group({ groupId, tabIds: [tab.id] });
      return tab;
    },

    async ownedTab(sessionId, tabId) {
      const groupId = await liveGroup(sessionId);
      if (groupId == null) throw new Error(NO_GROUP_MESSAGE);
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (tab?.groupId === groupId) return tab;
      const valid = (await api.tabs.query({ groupId })).map((t) => t.id);
      throw new Error(`Tab ${tabId} is not in this session's tab group. Valid tab IDs: ${valid.join(", ") || "none"}`);
    },

    async adoptOpened(tab) {
      if (tab.openerTabId == null) return;
      const opener = await api.tabs.get(tab.openerTabId).catch(() => null);
      if (!opener || ![...groups.values()].includes(opener.groupId)) return;
      await api.tabs.group({ groupId: opener.groupId, tabIds: [tab.id] });
    },

    close(sessionId) {
      groups.delete(sessionId);
    },
  };
}
