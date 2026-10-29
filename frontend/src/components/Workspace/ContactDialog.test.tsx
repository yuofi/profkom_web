// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContactDialog } from "./ContactDialog";
import { ActionForm } from "./ActionForm";
import { UnsavedChangesProvider, UnsavedChangesScope } from "./UnsavedChanges";
import { change, settle } from "../../test/workspace";

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true;this.querySelector<HTMLElement>("button")?.focus(); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await cleanup?.();cleanup = undefined;vi.restoreAllMocks(); });
async function mount() {
  const closed = vi.fn();
  function Example() {
    const [open, setOpen] = useState(false);
    return <><ActionForm fields={[{ name: "outside", label: "Другая форма", value: "Внешнее сохранено" }]} onSubmit={async () => {}} />
      <button onClick={() => setOpen(true)}>Подробнее</button>
      {open && <UnsavedChangesScope><ContactDialog title="Сведения участника" onClose={() => { closed();setOpen(false); }}>
        <p>Текст внутри диалога</p><ActionForm fields={[{ name: "inside", label: "Внутренняя форма", value: "Сохранено" }]} onSubmit={async () => {}} />
      </ContactDialog></UnsavedChangesScope>}</>;
  }
  const container = document.createElement("div");document.body.append(container);
  const root = createRoot(container), client = new QueryClient();
  const router = createMemoryRouter([{ path: "/", element: <UnsavedChangesProvider><Example /></UnsavedChangesProvider> }]);
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  cleanup = async () => { await act(async () => root.unmount());client.clear();router.dispose();container.remove(); };
  const opener = [...container.querySelectorAll("button")].find(button => button.textContent === "Подробнее")!;
  opener.focus();await act(async () => opener.click());
  const dialog = container.querySelector("dialog")!;
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left: 100, right: 500, top: 100, bottom: 400, x: 100, y: 100, width: 400, height: 300, toJSON: () => ({}) });
  return { container, dialog, opener, closed };
}
async function outside(dialog: HTMLDialogElement) {
  await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 })));
}
const button = (container: ParentNode, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;

it("closes only an actual backdrop click and restores focus to the opener", async () => {
  const page = await mount();
  const close = page.dialog.querySelector<HTMLButtonElement>('[aria-label="Закрыть сведения об участнике"]')!;
  expect(close.textContent).toBe("");expect(close.querySelector('[data-icon="close"]')).not.toBeNull();
  await act(async () => page.dialog.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 })));
  await act(async () => page.dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 150, clientY: 150 })));
  expect(page.closed).not.toHaveBeenCalled();expect(page.dialog.open).toBe(true);
  await outside(page.dialog);
  expect(page.closed).toHaveBeenCalledTimes(1);expect(page.container.querySelector("dialog")).toBeNull();expect(document.activeElement).toBe(page.opener);
});

it.each(["backdrop", "escape", "cross"])("%s closing preserves the scoped dirty form until confirmed", async method => {
  const page = await mount();
  const inside = page.dialog.querySelector<HTMLInputElement>('[name="inside"]')!, outsideField = page.container.querySelector<HTMLInputElement>('[name="outside"]')!;
  await change(outsideField, "Другой несохранённый ввод");await change(inside, "Не терять этот ввод");
  const close = async () => {
    if (method === "backdrop") await outside(page.dialog);
    else if (method === "escape") await act(async () => page.dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    else await act(async () => page.dialog.querySelector<HTMLButtonElement>('[aria-label="Закрыть сведения об участнике"]')!.click());
    await settle();
  };
  await close();expect(page.closed).not.toHaveBeenCalled();expect(inside.value).toBe("Не терять этот ввод");
  await act(async () => button(page.container, "Остаться").click());
  expect(page.dialog.open).toBe(true);expect(inside.value).toBe("Не терять этот ввод");
  await close();await act(async () => button(page.container, "Уйти без сохранения").click());await settle();
  expect(page.closed).toHaveBeenCalledTimes(1);expect(outsideField.value).toBe("Другой несохранённый ввод");
  expect(page.container.querySelector("dialog")).toBeNull();
});
