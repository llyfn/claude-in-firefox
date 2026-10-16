(() => {
  if (globalThis.__cf?.routerInstalled) return;
  const cf = (globalThis.__cf ??= {});
  cf.routerInstalled = true;
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.op !== "string") return undefined;
    const [module, fn] = msg.op.split(".");
    const target = cf[module]?.[fn];
    if (typeof target !== "function") return Promise.resolve({ error: `Unknown content op ${msg.op}` });
    return Promise.resolve()
      .then(() => target(msg.args ?? {}))
      .then((value) => ({ value }), (err) => ({ error: err?.message || String(err) }));
  });
})();
