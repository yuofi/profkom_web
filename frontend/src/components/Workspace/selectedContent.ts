/**
 * A callback ref for a select whose chosen value may be longer than its field: the value ends in «…» before the
 * arrow. Where the site draws its own list (`appearance: base-select`, WorkspaceLayout.module.css), the browser lets
 * the field's text be styled only through `<button><selectedcontent>`, which React 19.2 cannot render inside a select;
 * they are added here once the select is in the page and leave with it. Elsewhere nothing is added and the select's
 * own `text-overflow` applies.
 */
export function selectedContent(select: HTMLSelectElement | null) {
  if (!select || !globalThis.CSS?.supports?.("appearance: base-select") || select.firstElementChild instanceof HTMLButtonElement) return;
  const button = document.createElement("button");
  button.type = "button";
  button.append(document.createElement("selectedcontent"));
  select.prepend(button);
  return () => button.remove();
}
