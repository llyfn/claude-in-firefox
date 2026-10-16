(() => {
  if (window !== window.top || globalThis.__cf?.indicator) return;
  const cf = (globalThis.__cf ??= {});
  const SVG = "http://www.w3.org/2000/svg";
  let host = null;
  let cursor = null;
  let hideTimer = null;
  let visible = false;
  let suspended = false;

  function build() {
    host = document.createElement("claude-firefox-indicator");
    host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: none;";
    const root = host.attachShadow({ mode: "closed" });
    const glow = document.createElement("div");
    glow.style.cssText = "position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 15px rgba(217,119,87,.7), inset 0 0 25px rgba(217,119,87,.5), inset 0 0 35px rgba(217,119,87,.2);";
    cursor = document.createElementNS(SVG, "svg");
    cursor.setAttribute("width", "22");
    cursor.setAttribute("height", "22");
    cursor.setAttribute("viewBox", "0 0 24 24");
    cursor.style.cssText = "position: fixed; left: 0; top: 0; transform: translate(-100px, -100px); transition: transform 180ms ease-out; filter: drop-shadow(0 0 3px rgba(217,119,87,.8));";
    const arrow = document.createElementNS(SVG, "path");
    arrow.setAttribute("d", "M3 2 L3 19 L7.5 14.5 L10.5 21 L13 20 L10 13.5 L16.5 13.5 Z");
    arrow.setAttribute("fill", "#FAF9F5");
    arrow.setAttribute("stroke", "#D97757");
    arrow.setAttribute("stroke-width", "1.5");
    arrow.setAttribute("stroke-linejoin", "round");
    cursor.append(arrow);
    root.append(glow, cursor);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      glow.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 1000, direction: "alternate", iterations: Infinity });
    }
  }

  function render() {
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    host.style.display = visible && !suspended ? "block" : "none";
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
    moveCursor({ x, y }) {
      if (!host) build();
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    },
  };
})();
