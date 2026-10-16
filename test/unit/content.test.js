import test from "node:test";
import assert from "node:assert/strict";
import { createContent } from "../../extension/background/content.js";

test("a content call returns the page's value", async () => {
  const api = { tabs: { sendMessage: async () => ({ value: "ok" }) } };
  assert.equal(await createContent(api).call(1, 0, "dom.x"), "ok");
});

test("a page that never answers fails the call with a timeout instead of hanging", async () => {
  const api = { tabs: { sendMessage: () => new Promise(() => {}) } };
  await assert.rejects(createContent(api, { timeoutMs: 20 }).call(1, 0, "dom.x"), /^Error: The page did not respond to dom\.x within 0\.02s$/);
});
