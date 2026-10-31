/**
 * Copies text also outside a secure context (an HTTP stand has no navigator.clipboard):
 * the Clipboard API first, then a hidden selected textarea with execCommand("copy").
 * Resolves false when the browser refused both; the caller then offers the text selected.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text);return true; }
  } catch { /* a denied permission falls back to the selection copy */ }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;area.readOnly = true;area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0" });
  document.body.append(area);area.focus({ preventScroll: true });area.select();
  try { return typeof document.execCommand === "function" && document.execCommand("copy"); }
  catch { return false; }
  finally { area.remove();focused?.focus({ preventScroll: true }); }
}
