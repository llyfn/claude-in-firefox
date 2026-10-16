export function createDispatcher({ tools, sessions, activity, send }) {
  const tabQueues = new Map();

  function enqueue(tabId, fn) {
    const previous = tabQueues.get(tabId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => {});
    tabQueues.set(tabId, settled);
    settled.then(() => { if (tabQueues.get(tabId) === settled) tabQueues.delete(tabId); });
    return run;
  }

  async function execute({ sessionId, tool, args = {} }) {
    const def = tools[tool];
    if (!def) throw new Error(`Unknown tool: ${tool}`);
    if (!def.tabScoped) return def.run({ sessionId, args });
    const tabId = typeof args.tabId === "string" && /^\d+$/.test(args.tabId) ? Number(args.tabId) : args.tabId;
    if (!Number.isInteger(tabId)) throw new Error(`${tool}: tabId must be an integer`);
    return enqueue(tabId, async () => {
      const tab = await sessions.ownedTab(sessionId, tabId);
      activity.start(tab.id);
      try {
        return await def.run({ sessionId, args: { ...args, tabId }, tab });
      } finally {
        activity.end(tab.id);
      }
    });
  }

  return async function dispatch(msg) {
    if (msg.type === "session_closed") {
      sessions.close(msg.sessionId);
      return;
    }
    if (msg.type !== "call") return;
    let reply;
    try {
      reply = { content: toContent(await execute(msg)), isError: false };
    } catch (err) {
      reply = { content: [{ type: "text", text: err?.message || String(err) }], isError: true };
    }
    send({ type: "result", id: msg.id, ...reply });
  };
}

function toContent(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (Array.isArray(value)) return value;
  throw new Error("Tool returned an unsupported result");
}
