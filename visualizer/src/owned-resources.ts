/** Construct independently owned resources transactionally; caller owns success. */
export function constructOwned<T extends { destroy?: () => void }>(factories: readonly (() => T)[]): T[] {
  const resources: T[] = [];
  try {
    for (const factory of factories) resources.push(factory());
    return resources;
  } catch (error) {
    for (const resource of resources.reverse()) {
      // Preserve the construction error and still attempt every cleanup.
      try { resource.destroy?.(); } catch { /* best-effort rollback */ }
    }
    throw error;
  }
}
