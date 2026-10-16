import { targetSize, toCssPoint } from "./geometry.js";

const MAX_BASE64 = 1_398_100;
const clampScale = (scale) => Math.min(1, Math.max(0.1, Number(scale) || 1));
const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(",") + 1);

export function createCapture({ api, content }) {
  const frames = new Map();

  async function withIndicatorHidden(tabId, fn) {
    await content.call(tabId, 0, "indicator.suspend").catch(() => {});
    try {
      return await fn();
    } finally {
      await content.call(tabId, 0, "indicator.resume").catch(() => {});
    }
  }

  async function captureJpeg(tabId, scale) {
    for (let quality = 75; ; quality -= 10) {
      const dataUrl = await api.tabs.captureTab(tabId, { format: "jpeg", quality, scale });
      if (base64Of(dataUrl).length <= MAX_BASE64 || quality <= 25) return dataUrl;
    }
  }

  async function screenshot(tabId, { scale = 1 } = {}) {
    const vp = await content.call(tabId, 0, "input.viewport");
    const frame = targetSize(vp.width, vp.height);
    const s = clampScale(scale);
    const width = Math.max(1, Math.round(frame.width * s));
    const height = Math.max(1, Math.round(frame.height * s));
    // ImageDetails.scale is relative to CSS pixels, so this renders directly at the target size.
    const dataUrl = await withIndicatorHidden(tabId, () => captureJpeg(tabId, width / vp.width));
    frames.set(tabId, { cssW: vp.width, cssH: vp.height, shotW: frame.width, shotH: frame.height });
    return { base64: base64Of(dataUrl), mimeType: "image/jpeg", width, height, frame };
  }

  function toCss(tabId, [x, y]) {
    const frame = frames.get(tabId);
    return frame ? toCssPoint(frame, Number(x), Number(y)) : { x: Number(x), y: Number(y) };
  }

  async function zoom(tabId, region, { scale = 1 } = {}) {
    const [x0, y0, x1, y1] = region;
    const a = toCss(tabId, [x0, y0]);
    const b = toCss(tabId, [x1, y1]);
    const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    if (rect.width < 1 || rect.height < 1) throw new Error("zoom: region must have a positive width and height");
    const vp = await content.call(tabId, 0, "input.viewport");
    const target = targetSize(rect.width * vp.dpr, rect.height * vp.dpr);
    const s = clampScale(scale);
    const width = Math.max(1, Math.round(target.width * s));
    const height = Math.max(1, Math.round(target.height * s));
    const dataUrl = await withIndicatorHidden(tabId, () => api.tabs.captureTab(tabId, {
      format: "png",
      rect: { x: rect.x + vp.scrollX, y: rect.y + vp.scrollY, width: rect.width, height: rect.height },
      scale: width / rect.width,
    }));
    return { base64: base64Of(dataUrl), mimeType: "image/png", width, height };
  }

  return { screenshot, zoom, toCss };
}
