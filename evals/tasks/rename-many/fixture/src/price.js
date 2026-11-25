/** The sum of the prices of the items, each price times its quantity. */
export function totalPrice(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
