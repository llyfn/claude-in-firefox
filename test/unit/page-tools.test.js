import test from "node:test";
import assert from "node:assert/strict";
import { collectTree, pageTools } from "../../extension/background/tools/page.js";

function fakeContent(frames) {
  const calls = [];
  return {
    calls,
    async call(tabId, frameId, op, args) {
      calls.push({ frameId, op, args });
      const frame = frames[frameId];
      if (frame instanceof Error) throw frame;
      return { nodes: frame, truncated: false, viewport: { width: 800, height: 600 } };
    },
  };
}

test("cross-origin frames are spliced in under their iframe with prefixed refs", async () => {
  const content = fakeContent({
    0: [{ level: 0, role: "main", ref: "ref_1" }, { level: 1, role: "iframe", ref: "ref_2", frame: 7 }, { level: 1, role: "button", name: "After", ref: "ref_3" }],
    7: [{ level: 0, role: "button", name: "Inside", ref: "f7_ref_1" }],
  });
  const { nodes } = await collectTree(content, 1, { filter: "all", depth: 15, refId: null });
  assert.deepEqual(nodes.map((n) => [n.level, n.name ?? n.role]), [[0, "main"], [1, "iframe"], [2, "Inside"], [1, "After"]]);
  assert.deepEqual(content.calls.map((c) => [c.frameId, c.args.framePrefix]), [[0, ""], [7, "f7_"]]);
});

test("frame failures become a note instead of failing the whole read", async () => {
  const content = fakeContent({ 0: [{ level: 0, role: "iframe", ref: "ref_1", frame: 9 }], 9: new Error("Cannot access this page") });
  const text = await pageTools({ content }).read_page.run({ tab: { id: 1 }, args: {} });
  assert.match(text, /^iframe \[ref_1\] \[frame 9\]\n note "frame contents unavailable: Cannot access this page"\n\nViewport: 800x600$/);
});

test("a frame-prefixed ref_id is read from that frame", async () => {
  const content = fakeContent({ 7: [{ level: 0, role: "form", ref: "f7_ref_4" }] });
  await pageTools({ content }).read_page.run({ tab: { id: 1 }, args: { ref_id: "f7_ref_4" } });
  assert.deepEqual(content.calls[0], { frameId: 7, op: "tree.build", args: { filter: "all", depth: 15, refId: "f7_ref_4", framePrefix: "f7_" } });
});
