import { assertSameHost } from "../guard.js";

const EXEC_TIMEOUT_MS = 25_000;
const MAX_OUTPUT = 51_200;
const WRAPPABLE = /await is only valid|return not in function|Illegal return/i;
const SANDBOX_NOTE = "[ran in extension sandbox: page CSP blocks eval; use window.wrappedJSObject for page globals]\n";
const WRAPPED_NOTE = "[code was wrapped in an async function; use return to produce a value]\n";
const ERROR_TEXT = 'e && e.stack ? e.name + ": " + e.message + "\\n" + String(e.stack).split("\\n").slice(0, 3).join("\\n") : String(e)';

// Injected into the page as source text, so it must not reference anything outside itself.
function serialize(value) {
  const seen = new WeakSet();
  const walk = (v, depth) => {
    if (v === undefined) return "undefined";
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v === "string") return v.length > 1000 ? `${v.slice(0, 1000)}…[${v.length - 1000} more chars]` : v;
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "symbol") return v.toString();
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (typeof Node !== "undefined" && v instanceof Node) {
      if (v.nodeType !== 1) return `[${v.nodeName}]`;
      const id = v.id ? `#${v.id}` : "";
      const classes = typeof v.className === "string" && v.className.trim() ? `.${v.className.trim().split(/\s+/).join(".")}` : "";
      return `<${v.tagName.toLowerCase()}${id}${classes}>`;
    }
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (seen.has(v)) return "[Circular]";
    if (depth >= 5) return Array.isArray(v) ? `[Array(${v.length})]` : "[Object]";
    seen.add(v);
    if (Array.isArray(v)) {
      const items = v.slice(0, 100).map((item) => walk(item, depth + 1));
      if (v.length > 100) items.push(`…[${v.length - 100} more items]`);
      return items;
    }
    if (v instanceof Map) return { "[Map]": walk([...v.entries()], depth + 1) };
    if (v instanceof Set) return { "[Set]": walk([...v], depth + 1) };
    const out = {};
    for (const key of Object.keys(v)) {
      try {
        out[key] = walk(v[key], depth + 1);
      } catch (err) {
        out[key] = `[Error: ${err.message}]`;
      }
    }
    return out;
  };
  const result = walk(value, 0);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

// The page realm hands its result back through a DOM event: a string detail crosses the
// content-script boundary unchanged, which page Promises and objects do not reliably do.
export function pageProgram(code, { nonce, wrapAsync = false }) {
  const body = wrapAsync ? `(async () => {\n${code}\n})()` : code;
  const event = JSON.stringify(`__claude_firefox_js_${nonce}`);
  const inner = [
    "(async () => {",
    `  const serialize = ${serialize.toString()};`,
    "  let outcome;",
    `  try { outcome = { ok: true, value: serialize(await (0, eval)(${JSON.stringify(body)})) }; }`,
    `  catch (e) { outcome = { ok: false, error: ${ERROR_TEXT} }; }`,
    `  document.dispatchEvent(new CustomEvent(${event}, { detail: JSON.stringify(outcome) }));`,
    "})()",
  ].join("\n");
  return [
    "new Promise((resolve) => {",
    `  document.addEventListener(${event}, (e) => resolve(e.detail), { once: true });`,
    `  try { window.eval(${JSON.stringify(inner)}); }`,
    "  catch (e) { resolve(JSON.stringify({ ok: false, cspBlocked: true, error: String(e) })); }",
    "})",
  ].join("\n");
}

async function execute(api, tabId, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`javascript_tool timed out after ${EXEC_TIMEOUT_MS / 1000}s`)), EXEC_TIMEOUT_MS);
  });
  try {
    const [result] = await Promise.race([api.tabs.executeScript(tabId, { frameId: 0, code }), timeout]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

const limit = (text) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated at ${MAX_OUTPUT} characters]` : text);

async function inPage(api, tabId, code) {
  let outcome = JSON.parse(await execute(api, tabId, pageProgram(code, { nonce: crypto.randomUUID() })));
  if (!outcome.ok && !outcome.cspBlocked && WRAPPABLE.test(outcome.error)) {
    outcome = JSON.parse(await execute(api, tabId, pageProgram(code, { nonce: crypto.randomUUID(), wrapAsync: true })));
    if (outcome.ok) outcome.value = WRAPPED_NOTE + outcome.value;
  }
  return outcome;
}

async function inSandbox(api, tabId, code) {
  try {
    let value;
    try {
      value = await execute(api, tabId, code);
    } catch (err) {
      if (!WRAPPABLE.test(err.message)) throw err;
      value = await execute(api, tabId, `(async () => {\n${code}\n})()`);
    }
    return SANDBOX_NOTE + (value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } catch (err) {
    throw new Error(SANDBOX_NOTE + err.message);
  }
}

export function javascriptTool({ api }) {
  return {
    javascript_tool: {
      tabScoped: true,
      async run({ tab, args }) {
        if (args.action !== "javascript_exec") throw new Error('javascript_tool: action must be "javascript_exec"');
        const code = String(args.text ?? "");
        if (!code.trim()) throw new Error("javascript_tool: text is required");
        await assertSameHost(api, tab, "javascript_tool");
        const outcome = await inPage(api, tab.id, code);
        if (outcome.cspBlocked) return limit(await inSandbox(api, tab.id, code));
        if (!outcome.ok) throw new Error(limit(outcome.error));
        return limit(outcome.value);
      },
    },
  };
}
