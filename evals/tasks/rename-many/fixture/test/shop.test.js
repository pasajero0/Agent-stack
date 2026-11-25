import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal } from "../src/cart.js";
import { invoiceLine } from "../src/invoice.js";

const items = [
  { price: 3, qty: 2 },
  { price: 5, qty: 1 },
];

test("cartTotal adds the shipping cost", () => {
  assert.equal(cartTotal(items, 4), 15);
});

test("invoiceLine shows the amount due", () => {
  assert.equal(invoiceLine("Ann", items), "Ann: 11");
});
