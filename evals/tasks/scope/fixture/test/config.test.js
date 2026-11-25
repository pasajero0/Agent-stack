import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HOST, DEFAULT_PORT } from "../src/config.js";

test("the defaults are set", () => {
  assert.equal(typeof DEFAULT_PORT, "number");
  assert.equal(DEFAULT_HOST, "localhost");
});
