(() => {
  if (globalThis.__cf?.consoleHook) return;
  const cf = (globalThis.__cf ??= {});
  const MAX_TEXT = 16_384;
  const MAX_DEPTH = 3;
  const MAX_ITEMS = 100;
  const MAX_QUEUE = 1000;
  const MAX_STACK_LINES = 10;
  const queue = [];
  let dropped = 0;
  let timer = null;

  const flush = () => {
    timer = null;
    const entries = queue.splice(0);
    if (dropped) {
      entries.push({ level: "warn", text: `[${dropped} console messages dropped]`, url: location.href, time: Date.now() });
      dropped = 0;
    }
    if (entries.length) browser.runtime.sendMessage({ type: "console", entries }).catch(() => {});
  };

  const record = (level, text) => {
    if (queue.length >= MAX_QUEUE) {
      dropped++;
      return;
    }
    queue.push({ level, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…[truncated]` : text, url: location.href, time: Date.now() });
    timer ??= setTimeout(flush, 250);
  };

  const dataProp = (object, key) => {
    let current = object;
    for (let i = 0; current && i < 8; i++, current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    }
    return undefined;
  };

  const isError = (value) => typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object Error]";

  // Page errors arrive through Xrays, which expose only the native stack accessor, never a page-defined getter.
  const stackOf = (error) => {
    let stack;
    try {
      stack = error.stack;
    } catch {
      return "";
    }
    if (typeof stack !== "string" || !stack.trim()) return "";
    return `\n${stack.trim().split("\n").slice(0, MAX_STACK_LINES).map((line) => `    ${line.trim()}`).join("\n")}`;
  };

  // Every node costs at least its own length, so the walk stays within MAX_TEXT characters of work.
  const walk = (value, depth, ancestors, budget) => {
    if (budget.left <= 0) return "…";
    let out;
    if (typeof value === "string") {
      out = JSON.stringify(value.length > budget.left ? `${value.slice(0, budget.left)}…` : value);
    } else if (typeof value === "function") {
      out = "[Function]";
    } else if (typeof value !== "object" || value === null) {
      out = String(value);
    } else if (ancestors.has(value)) {
      out = "[Circular]";
    } else {
      const tag = Object.prototype.toString.call(value);
      const isArray = Array.isArray(value);
      if (tag === "[object Error]") {
        out = `${dataProp(value, "name")}: ${dataProp(value, "message")}`;
      } else if (!isArray && tag !== "[object Object]") {
        out = tag;
      } else if (depth > MAX_DEPTH) {
        out = isArray ? "[Array]" : "[Object]";
      } else {
        budget.left -= 2;
        ancestors.add(value);
        const parts = [];
        const child = (key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return !descriptor ? "undefined" : "value" in descriptor ? walk(descriptor.value, depth + 1, ancestors, budget) : "[getter]";
        };
        if (isArray) {
          for (let i = 0; i < Math.min(value.length, MAX_ITEMS) && budget.left > 0; i++) parts.push(child(String(i)));
          if (value.length > MAX_ITEMS) parts.push(`…${value.length - MAX_ITEMS} more`);
        } else {
          for (const key of Object.keys(value)) {
            if (budget.left <= 0) {
              parts.push("…");
              break;
            }
            budget.left -= key.length + 3;
            parts.push(`${JSON.stringify(key)}:${child(key)}`);
          }
        }
        ancestors.delete(value);
        return isArray ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
      }
    }
    budget.left -= out.length;
    return out;
  };

  const format = (value) => {
    try {
      if (typeof value === "string") return value;
      if (typeof value === "function") return String(value);
      const text = walk(value, 0, new Set(), { left: MAX_TEXT });
      return isError(value) ? `${text}${stackOf(value)}` : text;
    } catch {
      try {
        return String(value);
      } catch {
        return "[unprintable]";
      }
    }
  };

  cf.consoleHook = { format, record };
  const page = window.wrappedJSObject;
  if (!page) return;

  const levels = ["log", "info", "warn", "error", "debug"];
  // A forwarder installed by an earlier injection dies with its sandbox, so the page's own functions are kept on the console itself for later injections to find.
  if (!page.console.__claudeFirefoxConsoleOriginals) {
    const kept = new page.Object();
    for (const level of levels) kept[level] = page.console[level];
    const descriptor = new page.Object();
    descriptor.value = kept;
    descriptor.configurable = true;
    page.Object.defineProperty(page.console, "__claudeFirefoxConsoleOriginals", descriptor);
  }
  const originals = page.console.__claudeFirefoxConsoleOriginals;
  for (const level of levels) {
    const original = originals[level];
    exportFunction(function consoleProxy(...args) {
      try {
        record(level, args.map(format).join(" "));
      } catch {}
      try {
        return original.call(this, ...args);
      } catch {
        return undefined;
      }
    }, page.console, { defineAs: level });
  }
  window.addEventListener("error", (event) => record("exception", `${event.message} (${event.filename}:${event.lineno}:${event.colno})${event.error ? stackOf(event.error) : ""}`));
  window.addEventListener("unhandledrejection", (event) => record("exception", `Unhandled promise rejection: ${format(event.reason)}`));
})();
