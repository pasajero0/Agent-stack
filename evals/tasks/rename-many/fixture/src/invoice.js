import { totalPrice } from "./price.js";

/** One invoice line: the customer name and the amount due. */
export function invoiceLine(name, items) {
  return `${name}: ${totalPrice(items)}`;
}
