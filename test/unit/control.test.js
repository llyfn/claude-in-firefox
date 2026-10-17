import test from "node:test";
import assert from "node:assert/strict";
import { STOPPED_MESSAGE, createControl } from "../../extension/background/control.js";

function fakeSessions() {
  const stopped = new Set();
  const statuses = [];
  const sessions = {
    isStopped: async (id) => stopped.has(id),
    setStopped: async (id, value) => { if (value) stopped.add(id); else stopped.delete(id); },
    setStatus: async (id, status) => { statuses.push([id, status]); },
  };
  return { sessions, statuses };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("calls get a live abort signal and mark the session busy, then idle", async () => {
  const { sessions, statuses } = fakeSessions();
  const control = createControl({ sessions, idleAfterMs: 5 });
  let seen;
  assert.equal(await control.run("s", async (signal) => { seen = signal; return "ok"; }), "ok");
  assert.equal(seen.aborted, false);
  await sleep(20);
  assert.deepEqual(statuses, [["s", "busy"], ["s", "idle"]]);
});

test("Stop rejects the running call at once and aborts its signal", async () => {
  const { sessions } = fakeSessions();
  const changes = [];
  const control = createControl({ sessions, onChange: async (id) => { changes.push(id); }, idleAfterMs: 5 });
  let signal;
  const running = control.run("s", (s) => { signal = s; return new Promise(() => {}); });
  await tick();
  await control.stop("s");
  await assert.rejects(running, { message: STOPPED_MESSAGE });
  assert.equal(signal.aborted, true);
  assert.deepEqual(changes, ["s"]);
});

test("a stopped session refuses calls until Resume, and other sessions are unaffected", async () => {
  const { sessions } = fakeSessions();
  const control = createControl({ sessions, idleAfterMs: 5 });
  await control.stop("s");
  await assert.rejects(control.run("s", async () => "no"), { message: STOPPED_MESSAGE });
  assert.equal(await control.run("other", async () => "yes"), "yes");
  await control.resume("s");
  let seen;
  assert.equal(await control.run("s", async (signal) => { seen = signal; return "again"; }), "again");
  assert.equal(seen.aborted, false);
});
