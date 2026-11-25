/** Lower-case the text and join its words with a dash. */
export function slug(text) {
  return text.trim().toLowerCase().split(/\s+/).join("-");
}
