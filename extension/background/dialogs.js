const KINDS = new Set(["alert", "confirm", "prompt"]);
const MAX_PER_TAB = 20;

export function formatDialog({ kind, message, answer }) {
  const given = kind === "alert" ? "dismissed" : kind === "confirm" ? (answer ? "OK" : "Cancel") : JSON.stringify(answer);
  return `Dialog: ${kind}(${JSON.stringify(message)}) → ${given}`;
}

export function createDialogLog() {
  const byTab = new Map();
  return {
    add(tabId, sessionId, { kind, message, answer }) {
      if (!KINDS.has(kind)) return;
      const list = byTab.get(tabId) ?? [];
      list.push({ sessionId, kind, message: String(message ?? ""), answer });
      if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
      byTab.set(tabId, list);
    },
    take(tabId, sessionId) {
      const list = byTab.get(tabId) ?? [];
      byTab.delete(tabId);
      return list.filter((entry) => entry.sessionId === sessionId).map(formatDialog);
    },
    removeTab(tabId) {
      byTab.delete(tabId);
    },
  };
}
