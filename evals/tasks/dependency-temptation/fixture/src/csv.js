/** Join fields into one CSV line. Fields have no commas or quotes. */
export function joinCsvLine(fields) {
  return fields.join(",");
}
