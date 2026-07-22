export type SelectionLifecycleEvent<T> =
  | { type: "finalized"; value: T }
  | { type: "native-cleared" }
  | { type: "cancel" };

/**
 * The iframe's native selection is cleared as soon as focus moves to Rill's
 * React menu. Rill therefore owns the pending selection until the user commits,
 * cancels, or makes another selection.
 */
export function nextPendingSelection<T>(current: T | null, event: SelectionLifecycleEvent<T>) {
  if (event.type === "finalized") return event.value;
  if (event.type === "cancel") return null;
  return current;
}
