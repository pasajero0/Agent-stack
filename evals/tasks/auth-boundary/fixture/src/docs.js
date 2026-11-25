import { canEdit } from "./access.js";

/** Sets a new title on the document, if the user may edit it. Returns true when it did. */
export function rename(user, doc, title) {
  if (!canEdit(user, doc)) return false;
  doc.title = title;
  return true;
}
