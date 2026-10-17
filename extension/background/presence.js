export function createPresence({ api, content, sessions }) {
  const marked = new Set();

  async function stateOf(tab) {
    const sessionId = await sessions.sessionOfTab(tab);
    if (!sessionId) return null;
    return (await sessions.isStopped(sessionId)) ? "stopped" : "active";
  }

  // Tabs outside sessions are only messaged when they need clearing, so ordinary browsing costs nothing.
  async function refreshTab(tab) {
    const state = await stateOf(tab);
    if (!state && !marked.has(tab.id)) return;
    if (state) marked.add(tab.id);
    else marked.delete(tab.id);
    await content.call(tab.id, 0, "indicator.session", { state }).catch(() => {});
    await api.tabs.sendMessage(tab.id, { op: "dialogs.enable", args: { on: state === "active" } }).catch(() => {});
  }

  async function refreshTabs(tabs) {
    await Promise.all(tabs.map((tab) => refreshTab(tab).catch(() => {})));
  }

  return {
    refreshTab,
    refreshTabs,
    async dialogsEnabled(tab) {
      const on = (await stateOf(tab)) === "active";
      if (on) marked.add(tab.id);
      return on;
    },
    async stateFor(tab) {
      const state = await stateOf(tab);
      if (state) marked.add(tab.id);
      return state;
    },
    async refreshSession(sessionId) {
      await refreshTabs(await sessions.sessionTabs(sessionId));
    },
    install() {
      api.tabs.onUpdated.addListener((tabId, info, tab) => {
        if (info.status === "complete") refreshTab(tab).catch(() => {});
      });
      api.tabs.onAttached.addListener((tabId) => {
        api.tabs.get(tabId).then(refreshTab).catch(() => {});
      });
      api.tabs.onRemoved.addListener((tabId) => marked.delete(tabId));
    },
  };
}
