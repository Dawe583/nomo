export type DocumentOperation = {
  id: string;
  path: string;
  kind: string;
  at: string;
};

export function documentHistory<T extends DocumentOperation>(
  operations: readonly T[],
  search: string,
): T[] {
  const query = search.trim().toLowerCase();
  return operations
    .filter((operation) =>
      `${operation.path} ${operation.id}`.toLowerCase().includes(query),
    )
    .reverse();
}

export function documentContentState(content: string | null | undefined) {
  if (content === null) return "absent";
  if (content === undefined) return "unavailable";
  return content === "" ? "empty" : "content";
}
