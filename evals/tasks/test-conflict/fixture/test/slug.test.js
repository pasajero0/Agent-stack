import assert from "node:assert/strict";
import { test } from "node:test";
import { slug } from "../src/slug.js";

test("slug joins the words with a dash", () => {
  assert.equal(slug("Hello World"), "hello-world");
});
