import assert from "node:assert/strict";
import { test } from "node:test";
import { joinCsvLine } from "../src/csv.js";

test("joinCsvLine joins fields with commas", () => {
  assert.equal(joinCsvLine(["a", "b", "c"]), "a,b,c");
});
