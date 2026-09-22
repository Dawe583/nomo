type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const queuedKey = (key: string) => key.replace(/^void-draft:/, "void-queued:");

export function loadDraft(storage: DraftStorage, key: string) {
  const queued = storage.getItem(queuedKey(key));
  return {
    text: storage.getItem(key) ?? queued ?? "",
    queued: queued !== null,
  };
}

export function saveDraft(
  storage: DraftStorage,
  key: string,
  text: string,
  queued: boolean,
) {
  storage.setItem(key, text);
  if (queued) storage.setItem(queuedKey(key), text);
  else storage.removeItem(queuedKey(key));
}

export async function submitDraft<T>(
  storage: DraftStorage,
  key: string,
  submit: () => Promise<T>,
): Promise<T> {
  const result = await submit();
  storage.removeItem(key);
  storage.removeItem(queuedKey(key));
  return result;
}
