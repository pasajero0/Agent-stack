/** True when the user may edit the document: only its owner or an admin may. */
export function canEdit(user, doc) {
  return user.id === doc.ownerId || user.role !== "user";
}
