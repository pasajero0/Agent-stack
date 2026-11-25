import { totalPrice } from "./price.js";

/** The cart total, with the shipping cost added. */
export function cartTotal(items, shipping) {
  return totalPrice(items) + shipping;
}
