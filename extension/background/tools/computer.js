import { assertSameHost, guardFor } from "../guard.js";
import { watchNavigation } from "../navigation.js";
import { parseRef } from "../tree.js";

const CLICKS = {
  left_click: ["left", 1, "Clicked"],
  right_click: ["right", 1, "Right-clicked"],
  double_click: ["left", 2, "Double-clicked"],
  triple_click: ["left", 3, "Triple-clicked"],
};
const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const SETTLING = new Set(["left_click", "right_click", "double_click", "triple_click", "type", "key"]);
const HOVER_SETTLE_MS = 300;
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});
const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value ?? fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const image = (shot) => ({ type: "image", data: shot.base64, mimeType: shot.mimeType });

export function computerTool({ api, content, capture, watch = watchNavigation }) {
  async function act(tab, frameId, op, opArgs, action) {
    let frame = frameId;
    let args = { ...opArgs, guard: await guardFor(api, tab, frameId, action) };
    for (let hop = 0; ; hop++) {
      const result = (await content.call(tab.id, frame, op, args)) ?? {};
      if (!result.redirect) return result;
      if (hop >= 4) throw new Error("Too many nested frames");
      await assertSameHost(api, tab, action);
      frame = result.redirect.frameId;
      args = { ...opArgs, x: result.redirect.x ?? opArgs.x, y: result.redirect.y ?? opArgs.y, guard: null };
    }
  }

  function pointerTarget(tab, args, action) {
    if (args.ref != null && args.coordinate != null) throw new Error(`${action}: provide either ref or coordinate, not both`);
    if (args.ref != null) {
      const { frameId, ref } = parseRef(args.ref);
      return { frameId, args: { ref }, label: args.ref };
    }
    if (!Array.isArray(args.coordinate) || args.coordinate.length !== 2) throw new Error(`${action}: coordinate [x, y] or ref is required`);
    const [x, y] = args.coordinate.map(Number);
    const css = capture.toCss(tab.id, [x, y]);
    return { frameId: 0, args: { x: css.x, y: css.y }, label: `at (${x}, ${y})` };
  }

  async function moveCursor(tabId, frameId, point) {
    if (frameId === 0 && point) await content.call(tabId, 0, "indicator.moveCursor", point).catch(() => {});
  }

  async function screenshotBlocks(tab, scale) {
    const shot = await capture.screenshot(tab.id, { scale });
    const scaled = shot.width !== shot.frame.width ? `, scaled; coordinates use the ${shot.frame.width}x${shot.frame.height} frame` : "";
    return [{ type: "text", text: `Screenshot ${shot.width}x${shot.height} (jpeg)${scaled}` }, image(shot)];
  }

  async function perform(tab, args, signal) {
    const { action } = args;
    if (CLICKS[action]) {
      const [button, count, verb] = CLICKS[action];
      const target = pointerTarget(tab, args, action);
      const result = await act(tab, target.frameId, "input.click", { ...target.args, button, count, modifiers: args.modifiers ?? "" }, action);
      await moveCursor(tab.id, target.frameId, result.point);
      let text = `${verb} ${target.label}`;
      for (const url of result.opened ?? []) {
        const opened = await api.tabs.create({ url, openerTabId: tab.id, windowId: tab.windowId, active: false });
        await api.tabs.group({ groupId: tab.groupId, tabIds: [opened.id] });
        text += ` (link opened in new tab ${opened.id})`;
      }
      return text;
    }
    switch (action) {
      case "screenshot":
        return screenshotBlocks(tab, args.scale);
      case "zoom": {
        if (!Array.isArray(args.region) || args.region.length !== 4) throw new Error("zoom: region [x0, y0, x1, y1] is required");
        const region = args.region.map(Number);
        const shot = await capture.zoom(tab.id, region, { scale: args.scale });
        return [{ type: "text", text: `Zoomed region (${region[0]}, ${region[1]})-(${region[2]}, ${region[3]}) at ${shot.width}x${shot.height}` }, image(shot)];
      }
      case "wait": {
        const seconds = Number(args.duration);
        if (!(seconds > 0 && seconds <= 30)) throw new Error("wait: duration must be between 0 and 30 seconds");
        await sleep(seconds * 1000, signal);
        return `Waited ${seconds} second(s)`;
      }
      case "hover": {
        const target = pointerTarget(tab, args, action);
        const result = await act(tab, target.frameId, "input.hover", target.args, action);
        await moveCursor(tab.id, target.frameId, result.point);
        await sleep(HOVER_SETTLE_MS, signal);
        return `Hovered ${target.label}`;
      }
      case "scroll": {
        const direction = DIRECTIONS[args.scroll_direction];
        if (!direction) throw new Error('scroll: scroll_direction must be "up", "down", "left" or "right"');
        const amount = clampInt(args.scroll_amount, 1, 10, 3);
        const target = pointerTarget(tab, args, action);
        await act(tab, target.frameId, "input.scroll", { ...target.args, dx: direction[0] * amount * 100, dy: direction[1] * amount * 100 }, action);
        await sleep(200);
        return [{ type: "text", text: `Scrolled ${args.scroll_direction} by ${amount} ${target.label}` }, ...(await screenshotBlocks(tab, 1))];
      }
      case "scroll_to": {
        if (args.ref == null) throw new Error("scroll_to: ref is required");
        const { frameId, ref } = parseRef(args.ref);
        await act(tab, frameId, "input.scrollTo", { ref }, action);
        return `Scrolled ${args.ref} into view`;
      }
      case "left_click_drag": {
        if (!Array.isArray(args.start_coordinate) || !Array.isArray(args.coordinate)) throw new Error("left_click_drag: start_coordinate and coordinate are required");
        const [sx, sy] = args.start_coordinate.map(Number);
        const [ex, ey] = args.coordinate.map(Number);
        const from = capture.toCss(tab.id, [sx, sy]);
        const to = capture.toCss(tab.id, [ex, ey]);
        const result = await act(tab, 0, "input.drag", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, action);
        await moveCursor(tab.id, 0, result.point);
        return `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})`;
      }
      case "type": {
        if (typeof args.text !== "string" || args.text === "") throw new Error("type: text is required");
        await act(tab, 0, "input.type", { text: args.text }, action);
        return `Typed ${JSON.stringify(args.text)}`;
      }
      case "key": {
        if (typeof args.text !== "string" || !args.text.trim()) throw new Error("key: text is required");
        const repeat = clampInt(args.repeat, 1, 100, 1);
        const result = await act(tab, 0, "input.keys", { spec: args.text, repeat }, action);
        if (result.reload) {
          await api.tabs.reload(tab.id, { bypassCache: result.reload.bypassCache });
          return `Reloaded the tab${result.reload.bypassCache ? " (bypassing the cache)" : ""}`;
        }
        return `Pressed ${args.text}${repeat > 1 ? ` ×${repeat}` : ""}`;
      }
      default:
        throw new Error(`computer: unknown action "${action}"`);
    }
  }

  async function run({ tab, args, signal }) {
    if (!SETTLING.has(args.action)) return perform(tab, args, signal);
    const navigation = watch(api, tab.id, { signal });
    let result;
    try {
      result = await perform(tab, args, signal);
    } catch (err) {
      navigation.stop();
      throw err;
    }
    const suffix = await navigation.settle();
    return suffix ? `${result} ${suffix}` : result;
  }

  return { computer: { tabScoped: true, run } };
}
