import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAmount } from "../src/amount.js";

test("parseAmount reads a whole number", () => {
  assert.equal(parseAmount("42"), 42);
});

test("parseAmount refuses text with a space inside the number", () => {
  assert.equal(parseAmount("4 2"), null);
});

test("parseAmount refuses text that is not a number", () => {
  assert.equal(parseAmount("abc"), null);
});
