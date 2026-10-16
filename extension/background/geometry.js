export function targetSize(width, height, { maxSide = 1568, maxTiles = 1568, tile = 28 } = {}) {
  const w0 = Math.max(1, Math.round(width));
  const h0 = Math.max(1, Math.round(height));
  const fits = (w, h) => w <= maxSide && h <= maxSide && Math.ceil(w / tile) * Math.ceil(h / tile) <= maxTiles;
  const heightFor = (w) => Math.max(1, Math.round((w * h0) / w0));
  if (fits(w0, h0)) return { width: w0, height: h0 };
  let lo = 1;
  let hi = w0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid, heightFor(mid))) lo = mid;
    else hi = mid - 1;
  }
  return { width: lo, height: heightFor(lo) };
}

export function toCssPoint(frame, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coordinate (${x}, ${y})`);
  if (x < 0 || y < 0 || x > frame.shotW || y > frame.shotH) {
    throw new Error(`Coordinate (${x}, ${y}) is outside the ${frame.shotW}x${frame.shotH} screenshot. Take a new screenshot first.`);
  }
  return { x: Math.round((x * frame.cssW) / frame.shotW), y: Math.round((y * frame.cssH) / frame.shotH) };
}
