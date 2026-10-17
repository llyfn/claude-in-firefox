import test from "node:test";
import assert from "node:assert/strict";
import { coerceArgs } from "../../host/src/coerce.js";
import { TOOL_BY_NAME } from "../../host/src/tools.js";

const schemaOf = (name) => TOOL_BY_NAME.get(name).inputSchema;

test("JSON-encoded arrays and numeric strings become the arrays and numbers the schema asks for", () => {
  assert.deepEqual(coerceArgs(schemaOf("computer"), { action: "left_click", tabId: "12", coordinate: "[100, 200]" }), { action: "left_click", tabId: 12, coordinate: [100, 200] });
  assert.deepEqual(coerceArgs(schemaOf("computer"), { action: "zoom", tabId: 1, region: ["0", "0", "10", "10"] }).region, [0, 0, 10, 10]);
  assert.deepEqual(coerceArgs(schemaOf("file_upload"), { paths: '["/tmp/a.txt"]', ref: "ref_1", tabId: 1 }).paths, ["/tmp/a.txt"]);
});

test("quoted booleans become booleans only where the schema expects a boolean", () => {
  assert.equal(coerceArgs(schemaOf("tabs_context"), { createIfEmpty: "true" }).createIfEmpty, true);
  assert.equal(coerceArgs(schemaOf("read_console_messages"), { tabId: 1, onlyErrors: "false" }).onlyErrors, false);
  assert.equal(coerceArgs(schemaOf("computer"), { action: "type", tabId: 1, text: "true" }).text, "true");
});

test("values that may be strings stay strings", () => {
  assert.equal(coerceArgs(schemaOf("form_input"), { ref: "ref_1", value: "123", tabId: 1 }).value, "123");
  assert.equal(coerceArgs(schemaOf("form_input"), { ref: "ref_1", value: "true", tabId: 1 }).value, "true");
});

test("a whole argument object sent as JSON is parsed and invalid JSON is left alone", () => {
  assert.deepEqual(coerceArgs(schemaOf("navigate"), '{"url":"a.test","tabId":"3"}'), { url: "a.test", tabId: 3 });
  assert.equal(coerceArgs(schemaOf("computer"), { action: "left_click", tabId: 1, coordinate: "[1, 2" }).coordinate, "[1, 2");
  assert.equal(coerceArgs(schemaOf("computer"), { action: "scroll", tabId: 1, scroll_amount: "lots" }).scroll_amount, "lots");
  assert.equal(coerceArgs(schemaOf("navigate"), "not json"), "not json");
});

test("browser_batch actions and their inputs are parsed from JSON strings", () => {
  const actions = JSON.stringify([{ name: "computer", input: JSON.stringify({ action: "screenshot", tabId: "4" }) }]);
  assert.deepEqual(coerceArgs(schemaOf("browser_batch"), { actions }).actions, [{ name: "computer", input: { action: "screenshot", tabId: "4" } }]);
});
