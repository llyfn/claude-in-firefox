import test from "node:test";
import assert from "node:assert/strict";
import { framesSettled } from "../../extension/background/tools/tabs.js";

const top = { frameId: 0, parentFrameId: -1 };
const child = { frameId: 7, parentFrameId: 0 };

test("framesSettled waits until the child frame is registered", async () => {
  const polls = [[top], [top], [top, child]];
  let calls = 0;
  const api = {
    tabs: { executeScript: async () => [1] },
    webNavigation: { getAllFrames: async () => polls[Math.min(calls++, polls.length - 1)] },
  };
  await framesSettled(api, 1);
  assert.equal(calls, 3);
});

test("framesSettled resolves when getAllFrames rejects", async () => {
  const api = {
    tabs: { executeScript: async () => [1] },
    webNavigation: { getAllFrames: async () => { throw new Error("tab closed"); } },
  };
  await framesSettled(api, 1);
});
