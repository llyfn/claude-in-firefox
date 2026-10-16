import test from "node:test";
import assert from "node:assert/strict";
import { targetSize, toCssPoint } from "../../extension/background/geometry.js";

test("viewports within the image budget are left alone", () => {
  assert.deepEqual(targetSize(1280, 720), { width: 1280, height: 720 });
});

test("larger viewports shrink to the largest size within 1568 tiles of 28 px", () => {
  assert.deepEqual(targetSize(1440, 900), { width: 1389, height: 868 });
  const wide = targetSize(3000, 200);
  assert.ok(wide.width <= 1568);
  const big = targetSize(2560, 1440);
  assert.ok(Math.ceil(big.width / 28) * Math.ceil(big.height / 28) <= 1568);
  assert.ok(Math.abs(big.width / big.height - 2560 / 1440) < 0.01);
});

test("screenshot coordinates map back to CSS pixels and are bounds-checked", () => {
  const frame = { cssW: 1440, cssH: 900, shotW: 1389, shotH: 868 };
  assert.deepEqual(toCssPoint(frame, 1389, 868), { x: 1440, y: 900 });
  assert.deepEqual(toCssPoint(frame, 694.5, 434), { x: 720, y: 450 });
  assert.throws(() => toCssPoint(frame, 1400, 10), /outside the 1389x868 screenshot/);
  assert.throws(() => toCssPoint(frame, Number.NaN, 10), /Invalid coordinate/);
});
