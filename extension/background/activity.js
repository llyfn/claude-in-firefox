export function createActivity({ api, content }) {
  const running = new Map();
  const show = (tabId) => content.call(tabId, 0, "indicator.show").catch(() => {});

  api.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "complete" && running.has(tabId)) show(tabId);
  });

  return {
    start(tabId) {
      running.set(tabId, (running.get(tabId) ?? 0) + 1);
      show(tabId);
    },
    end(tabId) {
      const remaining = (running.get(tabId) ?? 1) - 1;
      if (remaining > 0) {
        running.set(tabId, remaining);
        return;
      }
      running.delete(tabId);
      content.call(tabId, 0, "indicator.hideSoon").catch(() => {});
    },
  };
}
