(() => {
  if (window !== window.top || globalThis.__cf?.indicator) return;
  const cf = (globalThis.__cf ??= {});
  const SVG = "http://www.w3.org/2000/svg";
  const ACCENT = "124, 92, 255";
  const PILL = { active: ["Claude is using this window", "Stop"], stopped: ["Stopped", "Resume"] };
  let host = null;
  let glow = null;
  let cursor = null;
  let pill = null;
  let pillLabel = null;
  let pillButton = null;
  let hideTimer = null;
  let visible = false;
  let suspended = false;
  let session = null;

  function build() {
    // A host left by an injection from before an add-on reload no longer has a working button.
    for (const stale of document.querySelectorAll("claude-firefox-indicator")) stale.remove();
    host = document.createElement("claude-firefox-indicator");
    host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: none;";
    const root = host.attachShadow({ mode: "closed" });
    glow = document.createElement("div");
    glow.style.cssText = `position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(${ACCENT}, .9), inset 0 0 28px rgba(${ACCENT}, .45);`;
    cursor = document.createElementNS(SVG, "svg");
    cursor.setAttribute("width", "22");
    cursor.setAttribute("height", "22");
    cursor.setAttribute("viewBox", "0 0 24 24");
    cursor.style.cssText = `position: fixed; left: 0; top: 0; transform: translate(-100px, -100px); transition: transform 180ms ease-out; filter: drop-shadow(0 0 3px rgba(${ACCENT}, .8));`;
    const arrow = document.createElementNS(SVG, "path");
    arrow.setAttribute("d", "M3 2 L3 19 L7.5 14.5 L10.5 21 L13 20 L10 13.5 L16.5 13.5 Z");
    arrow.setAttribute("fill", "#FFFFFF");
    arrow.setAttribute("stroke", `rgb(${ACCENT})`);
    arrow.setAttribute("stroke-width", "1.5");
    arrow.setAttribute("stroke-linejoin", "round");
    cursor.append(arrow);
    pill = document.createElement("div");
    pill.style.cssText = "position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: none; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border-radius: 999px; background: rgba(24, 20, 38, .92); color: #fff; font: 13px/1.2 system-ui, sans-serif; box-shadow: 0 2px 12px rgba(0, 0, 0, .3); pointer-events: auto;";
    pillLabel = document.createElement("span");
    pillButton = document.createElement("button");
    pillButton.type = "button";
    pillButton.tabIndex = -1;
    pillButton.addEventListener("mousedown", (event) => event.preventDefault());
    pillButton.style.cssText = `all: unset; cursor: pointer; padding: 4px 12px; border-radius: 999px; background: rgb(${ACCENT}); color: #fff; font: 600 13px/1.2 system-ui, sans-serif;`;
    // Only the user can press this: Claude's input is synthetic and never trusted.
    pillButton.addEventListener("click", (event) => {
      if (!event.isTrusted || !session) return;
      browser.runtime.sendMessage({ type: "control", action: session === "stopped" ? "resume" : "stop" }).catch(() => {});
    });
    pill.append(pillLabel, pillButton);
    root.append(glow, cursor, pill);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      glow.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 1000, direction: "alternate", iterations: Infinity });
    }
  }

  function render() {
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    glow.style.display = visible ? "block" : "none";
    cursor.style.display = visible ? "block" : "none";
    pill.style.display = session ? "flex" : "none";
    if (session) [pillLabel.textContent, pillButton.textContent] = PILL[session];
    host.style.display = (visible || session) && !suspended ? "block" : "none";
  }

  cf.indicator = {
    show() {
      clearTimeout(hideTimer);
      visible = true;
      render();
    },
    hideSoon() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        visible = false;
        render();
      }, 2000);
    },
    suspend() {
      suspended = true;
      if (host) render();
    },
    resume() {
      suspended = false;
      if (host) render();
    },
    session({ state }) {
      session = state === "active" || state === "stopped" ? state : null;
      if (!session && !host) return {};
      render();
      return {};
    },
    moveCursor({ x, y }) {
      if (!host) build();
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    },
  };

  browser.runtime.sendMessage({ type: "indicator.query" }).then((reply) => {
    if (reply && "state" in reply) cf.indicator.session({ state: reply.state });
  }, () => {});
})();
