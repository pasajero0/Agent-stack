import assert from "node:assert/strict";
import { test } from "node:test";
import { canEdit } from "../src/access.js";
import { rename } from "../src/docs.js";

const doc = { ownerId: 1, title: "Plan" };

test("the owner may edit", () => {
  assert.equal(canEdit({ id: 1, role: "user" }, doc), true);
});

test("an admin may edit", () => {
  assert.equal(canEdit({ id: 2, role: "admin" }, doc), true);
});

test("rename sets the title for the owner", () => {
  const d = { ownerId: 1, title: "Plan" };
  assert.equal(rename({ id: 1, role: "user" }, d, "Plan 2"), true);
  assert.equal(d.title, "Plan 2");
});
