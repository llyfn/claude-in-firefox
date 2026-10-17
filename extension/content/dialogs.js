(() => {
  if (globalThis.__cf?.dialogs) return;
  const cf = (globalThis.__cf ??= {});
  const MAX_MESSAGE = 500;
  let enabled = false;

  const text = (value) => {
    try {
      return String(value ?? "").slice(0, MAX_MESSAGE);
    } catch {
      return "";
    }
  };
  const report = (kind, message, answer) => {
    browser.runtime.sendMessage({ type: "dialog", kind, message: text(message), answer }).catch(() => {});
  };

  cf.dialogs = {
    enable({ on }) {
      enabled = on === true;
      return {};
    },
  };

  // At document_start this runs before page scripts, so stopping propagation keeps their handlers from asking "Leave page?".
  window.addEventListener("beforeunload", (event) => { if (enabled) event.stopImmediatePropagation(); }, true);

  browser.runtime.sendMessage({ type: "dialogs.query" }).then((reply) => {
    if (typeof reply?.on === "boolean") enabled = reply.on;
  }, () => {});

  const page = window.wrappedJSObject;
  if (!page) return;
  // As in console-hook.js, the page's functions are kept on the window for later injections to find.
  if (!page.__claudeFirefoxDialogOriginals) {
    const kept = new page.Object();
    for (const name of ["alert", "confirm", "prompt"]) kept[name] = page[name];
    const descriptor = new page.Object();
    descriptor.value = kept;
    descriptor.configurable = true;
    page.Object.defineProperty(page, "__claudeFirefoxDialogOriginals", descriptor);
  }
  const originals = page.__claudeFirefoxDialogOriginals;

  exportFunction(function alert(...args) {
    if (!enabled) return originals.alert.call(this, ...args);
    report("alert", args[0], null);
    return undefined;
  }, page, { defineAs: "alert" });
  exportFunction(function confirm(...args) {
    if (!enabled) return originals.confirm.call(this, ...args);
    report("confirm", args[0], true);
    return true;
  }, page, { defineAs: "confirm" });
  exportFunction(function prompt(...args) {
    if (!enabled) return originals.prompt.call(this, ...args);
    const answer = args[1] === undefined ? "" : String(args[1]);
    report("prompt", args[0], text(answer));
    return answer;
  }, page, { defineAs: "prompt" });
})();
