/** Turn text like "42" into the number 42. Returns null if the text is not a whole number. */
export function parseAmount(text) {
  if (!/^[0-9]+$/.test(text)) return null;
  return Number(text);
}
