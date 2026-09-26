/** Composer contracts that the visible UI and the send guard have to share.
 * A counter that can disagree with the limit it warns about is worse than no
 * counter, so both read the same numbers. */

/** The send guard in `chat.tsx` rejects a prompt over either bound. The visible
 * budget reads the same two constants. */
export const MESSAGE_CHAR_LIMIT = 32000;
export const MESSAGE_BYTE_LIMIT = 60000;
export const ATTACHMENT_BYTE_LIMIT = 24576;

export type MessageSize = {
  readonly chars: number;
  readonly bytes: number;
  /** The fraction of the tightest bound this prompt reaches. */
  readonly pressure: number;
  readonly over: boolean;
};

export function messageSize(prompt: string): MessageSize {
  const chars = prompt.length;
  const bytes = new TextEncoder().encode(JSON.stringify({ prompt })).length;
  const pressure = Math.max(chars / MESSAGE_CHAR_LIMIT, bytes / MESSAGE_BYTE_LIMIT);
  return {
    chars,
    bytes,
    pressure,
    over: chars > MESSAGE_CHAR_LIMIT || bytes > MESSAGE_BYTE_LIMIT,
  };
}

/** Attachments are inlined into the prompt, so their bytes count against the
 * character and byte budget the moment they are added. */
export function attachmentBytes(
  list: readonly { bytes: number }[],
): number {
  return list.reduce((total, entry) => total + entry.bytes, 0);
}

/** Past this share of a bound the budget line appears, so an ordinary draft
 * never pays for a warning it does not need. */
export const BUDGET_VISIBLE_AT = 0.8;

export type DraftFile = { name: string; content: string; bytes: number };

const filesKey = (key: string) => key.replace(/^void-draft:/, "void-files:");

/** The draft text survives a route change through `draft-state`, so its
 * attachments have to survive with it. A restored draft that silently lost its
 * files would send a different message than the one on screen. */
export function loadDraftFiles(
  storage: Pick<Storage, "getItem">,
  key: string,
): DraftFile[] {
  const raw = storage.getItem(filesKey(key));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DraftFile =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as DraftFile).name === "string" &&
        typeof (entry as DraftFile).content === "string" &&
        Number.isFinite((entry as DraftFile).bytes),
    );
  } catch {
    // A corrupt draft is a lost attachment, not a failed conversation: the
    // composer still opens and the user can re-add the file.
    return [];
  }
}

export function saveDraftFiles(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  files: readonly DraftFile[],
): void {
  if (files.length) storage.setItem(filesKey(key), JSON.stringify(files));
  else storage.removeItem(filesKey(key));
}

/** Clears the files the moment a send is accepted, in the same imperative
 * block that clears the draft text. The effect that mirrors `attachments`
 * into storage would otherwise be the only writer, and a route change or an
 * unmount between the accepted send and that effect leaves the old
 * `…:new` files key behind, so returning to /chat/new restores attachments
 * against an empty draft. */
export function clearDraftFiles(
  storage: Pick<Storage, "removeItem">,
  key: string,
): void {
  storage.removeItem(filesKey(key));
}
