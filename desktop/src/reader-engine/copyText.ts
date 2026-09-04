type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export async function copyPlainText(
  text: string,
  clipboard?: ClipboardWriter,
  ownerDocument?: Document,
) {
  if (!text) return false;
  try {
    const writer = clipboard ?? globalThis.navigator?.clipboard;
    if (!writer) throw new Error("Clipboard API is unavailable");
    await writer.writeText(text);
    return true;
  } catch {
    const document = ownerDocument ?? globalThis.document;
    if (!document) return false;
    let textarea: HTMLTextAreaElement | null = null;
    try {
      textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      try {
        textarea?.remove();
      } catch {
        // Cleanup is best effort; copy failure is already reported to the caller.
      }
    }
  }
}
