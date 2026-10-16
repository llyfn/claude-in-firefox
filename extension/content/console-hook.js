(() => {
  if (globalThis.__cf?.consoleHook) return;
  const cf = (globalThis.__cf ??= {});
  cf.consoleHook = true;
  const page = window.wrappedJSObject;
  const queue = [];
  let timer = null;

  const flush = () => {
    timer = null;
    const entries = queue.splice(0);
    if (entries.length) browser.runtime.sendMessage({ type: "console", entries }).catch(() => {});
  };

  const record = (level, text) => {
    queue.push({ level, text: text.length > 16_384 ? `${text.slice(0, 16_384)}…[truncated]` : text, url: location.href, time: Date.now() });
    timer ??= setTimeout(flush, 250);
  };

  const format = (value) => {
    try {
      if (typeof value === "string") return value;
      if (value === undefined) return "undefined";
      if (typeof value !== "object" || value === null) return String(value);
      const raw = XPCNativeWrapper.unwrap(value);
      if (typeof raw.message === "string" && typeof raw.name === "string" && "stack" in raw) return `${raw.name}: ${raw.message}`;
      return JSON.stringify(raw) ?? String(raw);
    } catch {
      try {
        return String(value);
      } catch {
        return "[unprintable]";
      }
    }
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = page.console[level];
    exportFunction(function consoleProxy(...args) {
      record(level, args.map(format).join(" "));
      return original.call(this, ...args);
    }, page.console, { defineAs: level });
  }
  window.addEventListener("error", (event) => record("exception", `${event.message} (${event.filename}:${event.lineno}:${event.colno})`));
  window.addEventListener("unhandledrejection", (event) => record("exception", `Unhandled promise rejection: ${format(event.reason)}`));
})();
