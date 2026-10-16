const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function makeMatcher(pattern) {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, "i");
    return (text) => re.test(text);
  } catch {
    const needle = pattern.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }
}

export function createLogStore({ maxConsole = 10_000, maxNetwork = 1_000 } = {}) {
  const tabs = new Map();
  const entry = (tabId) => {
    let state = tabs.get(tabId);
    if (!state) {
      state = { consoleOrigin: null, networkOrigin: null, console: [], network: new Map() };
      tabs.set(tabId, state);
    }
    return state;
  };

  return {
    addConsole(tabId, entries) {
      const state = entry(tabId);
      state.console.push(...entries);
      if (state.console.length > maxConsole) state.console.splice(0, state.console.length - maxConsole);
    },
    committed(tabId, url) {
      const state = entry(tabId);
      const origin = originOf(url);
      if (state.consoleOrigin !== origin) {
        state.console = [];
        state.consoleOrigin = origin;
      }
    },
    requestStarted(tabId, { requestId, method, url, type }) {
      const state = entry(tabId);
      if (type === "main_frame" && state.networkOrigin !== originOf(url)) {
        state.network.clear();
        state.networkOrigin = originOf(url);
      }
      state.network.set(requestId, { method, url, type, status: "pending" });
      if (state.network.size > maxNetwork) state.network.delete(state.network.keys().next().value);
    },
    requestFinished(tabId, requestId, status) {
      const request = tabs.get(tabId)?.network.get(requestId);
      if (request) request.status = status;
    },
    removeTab(tabId) {
      tabs.delete(tabId);
    },
    readConsole(tabId, { onlyErrors = false, pattern, limit = 100, clear = false } = {}) {
      const state = entry(tabId);
      const matches = makeMatcher(pattern);
      const found = state.console.filter((m) => (!onlyErrors || m.level === "error" || m.level === "exception") && matches(m.text));
      if (clear) state.console = [];
      if (!found.length) return `No console messages found${pattern ? ` matching "${pattern}"` : ""}${onlyErrors ? " (errors only)" : ""}.`;
      const shown = found.slice(-limit);
      const header = `Found ${found.length} console message(s)${found.length > shown.length ? `, showing the last ${shown.length}` : ""}:`;
      return [header, "", ...shown.map((m, i) => `[${i + 1}] [${clock(m.time)}] [${m.level.toUpperCase()}] (${m.url}) ${m.text}`)].join("\n");
    },
    readNetwork(tabId, { urlPattern, limit = 100, clear = false } = {}) {
      const state = entry(tabId);
      const found = [...state.network.values()].filter((r) => !urlPattern || r.url.includes(urlPattern));
      if (clear) state.network.clear();
      if (!found.length) return `No network requests found${urlPattern ? ` matching "${urlPattern}"` : ""}.`;
      const shown = found.slice(-limit);
      const header = `Found ${found.length} request(s)${found.length > shown.length ? `, showing the last ${shown.length}` : ""}:`;
      return [header, "", ...shown.map((r, i) => `${i + 1}. url: ${r.url}\n   method: ${r.method}\n   statusCode: ${r.status}`)].join("\n");
    },
  };
}

export function installLogListeners(api, store) {
  const filter = { urls: ["<all_urls>"] };
  api.webRequest.onBeforeRequest.addListener((d) => { if (d.tabId >= 0) store.requestStarted(d.tabId, d); }, filter);
  api.webRequest.onCompleted.addListener((d) => { if (d.tabId >= 0) store.requestFinished(d.tabId, d.requestId, String(d.statusCode)); }, filter);
  api.webRequest.onErrorOccurred.addListener((d) => { if (d.tabId >= 0) store.requestFinished(d.tabId, d.requestId, `failed (${d.error})`); }, filter);
  api.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) store.committed(d.tabId, d.url); });
  api.tabs.onRemoved.addListener((tabId) => store.removeTab(tabId));
  api.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === "console" && sender.tab) store.addConsole(sender.tab.id, msg.entries);
  });
}
