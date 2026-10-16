import test from "node:test";
import assert from "node:assert/strict";
import { domainChangedMessage, guardFor, hostOf } from "../../extension/background/guard.js";

const apiWithUrl = (url) => ({ tabs: { get: async () => ({ id: 1, url }) } });

test("hostOf extracts hostnames and tolerates odd URLs", () => {
  assert.equal(hostOf("https://www.example.test/a?b"), "www.example.test");
  assert.equal(hostOf("about:blank"), "");
  assert.equal(hostOf("not a url"), "");
});

test("guardFor hands frame 0 a host guard and checks other frames immediately", async () => {
  const tab = { id: 1, url: "https://a.test/page" };
  assert.deepEqual(await guardFor(apiWithUrl("https://a.test/other"), tab, 0, "left_click"), { host: "a.test", action: "left_click" });
  assert.equal(await guardFor(apiWithUrl("https://a.test/other"), tab, 7, "left_click"), null);
  await assert.rejects(guardFor(apiWithUrl("https://evil.test/"), tab, 7, "left_click"), { message: domainChangedMessage("left_click") });
});
