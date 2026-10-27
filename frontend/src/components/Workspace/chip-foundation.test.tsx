// @vitest-environment jsdom
import { act, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, change, field, waitForPage } from "../../test/workspace";
import { directoryApi } from "../../utils/api/directory.api";
import { ChipFace, ChipInitials } from "./ChipFace";
import { InteractiveChip } from "./InteractiveChip";
import { HoverCard } from "./HoverCard";
import { AnchoredPopover } from "./AnchoredPopover";
import { EntityPicker } from "./EntityPicker";
import { ActionForm } from "./ActionForm";
import { UnsavedChangesProvider, UnsavedChangesScope } from "./UnsavedChanges";
import { useGuardedAction } from "./unsavedChangesHooks";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let cleanupGuard: (() => Promise<void>) | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;await cleanupGuard?.();cleanupGuard = undefined;vi.restoreAllMocks(); });
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;
async function click(node: HTMLElement) { await act(async () => { node.focus();node.click(); }); }

it("display identity has no action, query or focus target and safely falls back to explicit block initials", async () => {
  const read = vi.spyOn(directoryApi, "contacts");page = await mountWorkspace(<><InteractiveChip kind="display" label="Участник" avatarUrl={null} /><ChipFace label="Инфо блок" avatarUrl="https://outside.invalid/avatar.png" avatarFallback={<ChipInitials name="Инфо блок" />} /></>);
  expect(page.container.querySelector("a,button,[tabindex]")).toBeNull();expect(page.container.querySelector("img")?.getAttribute("src")).toBe("/avatars/default.svg");expect(page.container.textContent).toContain("ИБ");expect(read).not.toHaveBeenCalled();
});
it("link keeps native modified clicks and normal router navigation", async () => {
  page = await mountWorkspace(<Routes><Route path="/from" element={<InteractiveChip kind="link" to="/target" label="Команда" />} /><Route path="/target" element={<p>Цель открыта</p>} /></Routes>, { path: "/from" });
  const link = page.container.querySelector<HTMLAnchorElement>("a")!;expect(link.getAttribute("href")).toBe("/target");
  for (const modifier of ["ctrlKey", "metaKey"]) {
    let prevented: boolean | undefined;document.addEventListener("click", event => { prevented = event.defaultPrevented;event.preventDefault(); }, { once: true });
    await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, [modifier]: true })));expect(prevented).toBe(false);expect(page.container.textContent).not.toContain("Цель открыта");
  }
  await click(link);expect(page.container.textContent).toContain("Цель открыта");
});
it("primary action and trailing action are separate native siblings and the trailing action never invokes the primary", async () => {
  const primary = vi.fn(), trailing = vi.fn(), row = vi.fn();page = await mountWorkspace(<div onClick={row}><InteractiveChip kind="action" label="Исполнитель" onClick={primary} trailingAction={{ label: "Убрать исполнителя", onClick: trailing }} /></div>);
  const buttons = page.container.querySelectorAll<HTMLButtonElement>("button");expect(buttons).toHaveLength(2);expect(buttons[0].parentElement).toBe(buttons[1].parentElement);expect(page.container.querySelector("button button,a button")).toBeNull();await click(buttons[1]);expect(trailing).toHaveBeenCalledTimes(1);expect(primary).not.toHaveBeenCalled();expect(row).not.toHaveBeenCalled();await click(buttons[0]);expect(primary).toHaveBeenCalledTimes(1);
});
it("hover content mounts lazily after the default delay or focus and Escape closes only the preview", async () => {
  const mounted = vi.fn(), outer = vi.fn();function Body() { useEffect(() => { mounted(); }, []);return <p>Только чтение</p>; }
  page = await mountWorkspace(<div onKeyDown={outer}><HoverCard content={() => <Body />}>{({ describedBy }) => <InteractiveChip kind="action" label="Карточка" onClick={() => {}} ariaDescribedBy={describedBy} />}</HoverCard></div>);
  const trigger = page.container.querySelector<HTMLButtonElement>("button")!;expect(mounted).not.toHaveBeenCalled();await act(async () => { trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));await new Promise(resolve => setTimeout(resolve, 100)); });expect(mounted).not.toHaveBeenCalled();await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); });expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Только чтение");expect(mounted).toHaveBeenCalledTimes(1);
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));expect(document.querySelector('[role="tooltip"]')).toBeNull();expect(outer).not.toHaveBeenCalled();await act(async () => trigger.focus());expect(document.querySelector('[role="tooltip"]')).not.toBeNull();expect(mounted).toHaveBeenCalledTimes(2);
});
it("anchored form portals to the current dialog, focuses its field and returns focus only when actually closed", async () => {
  function Probe() { const anchor = useRef<HTMLSpanElement>(null), [open, setOpen] = useState(false);return <dialog open><InteractiveChip kind="action" label="Правка" anchorRef={anchor} onClick={() => setOpen(true)} /><AnchoredPopover open={open} anchorRef={anchor} label="Поля" onRequestClose={() => setOpen(false)} width={5000}><label>Заметка<input name="note" /></label></AnchoredPopover></dialog>; }
  page = await mountWorkspace(<Probe />);const trigger = button(page.container, "Правка");await click(trigger);const layer = document.querySelector<HTMLElement>("[data-anchored-popover]")!;expect(layer.parentElement?.tagName).toBe("DIALOG");expect(layer.getAttribute("aria-modal")).toBe("false");expect(document.activeElement).toBe(layer.querySelector("input"));expect(Number.parseFloat(layer.style.width)).toBeLessThanOrEqual(window.innerWidth - 16);expect(Number.parseFloat(layer.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 16);
  await click(button(layer, "Закрыть окно"));expect(document.querySelector("[data-anchored-popover]")).toBeNull();expect(document.activeElement).toBe(trigger);
});
it("outside and Escape request closure without discarding a controlled form, and nested entity suggestions belong to it", async () => {
  const requested = vi.fn();function Probe() { const anchor = useRef<HTMLSpanElement>(null), [open, setOpen] = useState(false), [value, setValue] = useState("");return <><InteractiveChip kind="action" label="Открыть" anchorRef={anchor} onClick={() => setOpen(true)} /><button data-outside>Снаружи</button><AnchoredPopover open={open} anchorRef={anchor} label="Назначение" onRequestClose={requested}><EntityPicker label="Участник" value={value} onChange={setValue} options={[{ value: "known", label: "Известный" }]} /></AnchoredPopover></>; }
  page = await mountWorkspace(<Probe />);await click(button(page.container, "Открыть"));await waitForPage(page);const search = document.querySelector<HTMLInputElement>('[data-anchored-popover] [role="combobox"]')!;await click(search);const option = document.querySelector<HTMLElement>('[data-entity-picker-popup] [data-option-value="known"]')!;
  await act(async () => { option.dispatchEvent(new Event("pointerdown", { bubbles: true }));option.click(); });expect(requested).not.toHaveBeenCalled();expect(document.querySelector('[data-selected-value="known"]')).not.toBeNull();
  await act(async () => page!.container.querySelector('[data-outside]')!.dispatchEvent(new Event("pointerdown", { bubbles: true })));expect(requested).toHaveBeenCalledTimes(1);expect(document.querySelector('[data-anchored-popover]')).not.toBeNull();await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));expect(requested).toHaveBeenCalledTimes(2);expect(document.querySelector('[data-selected-value="known"]')).not.toBeNull();
});
it("busy anchored form cannot close through Escape, outside pointer or close button", async () => {
  const requested = vi.fn();function Probe() { const anchor = useRef<HTMLSpanElement>(null);return <><InteractiveChip kind="display" label="Якорь" anchorRef={anchor} /><AnchoredPopover open anchorRef={anchor} label="Сохраняется" onRequestClose={requested} busy><input name="busy" /></AnchoredPopover></>; }
  page = await mountWorkspace(<Probe />);const layer = document.querySelector<HTMLElement>('[data-anchored-popover]')!;expect(button(layer, "Закрыть окно").disabled).toBe(true);await act(async () => { layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });expect(requested).not.toHaveBeenCalled();expect(layer.isConnected).toBe(true);
});
async function mountGuard(element: ReactNode) {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient();
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [{ path: "/source", element }, { path: "/target", element: <p>Перешли</p> }] }], { initialEntries: ["/source"] });
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));cleanupGuard = async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove(); };return { container, router };
}
it("router chip respects the existing unsaved-change navigation guard", async () => {
  const save = vi.fn(async () => {});const guarded = await mountGuard(<><InteractiveChip kind="link" label="Уйти" to="/target" /><ActionForm fields={[{ name: "draft", label: "Черновик" }]} onSubmit={save} /></>);await change(field(guarded.container, "draft"), "Сохранить ввод");await click(guarded.container.querySelector<HTMLAnchorElement>("a")!);expect(guarded.router.state.location.pathname).toBe("/source");expect(guarded.container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");await click(button(guarded.container, "Остаться"));expect(field(guarded.container, "draft").value).toBe("Сохранить ввод");expect(save).not.toHaveBeenCalled();
});
it("anchored popover uses its owner's scoped guard and keeps a dirty draft until explicit discard", async () => {
  const save = vi.fn(async () => {});function Editor() { const anchor = useRef<HTMLSpanElement>(null), [open, setOpen] = useState(false), leave = useGuardedAction();return <><InteractiveChip kind="action" label="Править" anchorRef={anchor} onClick={() => setOpen(true)} /><AnchoredPopover open={open} anchorRef={anchor} label="Исправление" onRequestClose={() => leave(() => setOpen(false))}><ActionForm fields={[{ name: "draft", label: "Черновик" }]} onSubmit={save} allowExitSave={false} /></AnchoredPopover></>; }
  const guarded = await mountGuard(<UnsavedChangesScope><Editor /></UnsavedChangesScope>);await click(button(guarded.container, "Править"));const layer = document.querySelector<HTMLElement>('[data-anchored-popover]')!;await change(field(layer, "draft"), "Не терять");await click(button(layer, "Закрыть окно"));expect(layer.isConnected).toBe(true);expect(guarded.container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");await click(button(guarded.container, "Остаться"));expect(field(layer, "draft").value).toBe("Не терять");await click(button(layer, "Закрыть окно"));await click(button(guarded.container, "Уйти без сохранения"));expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(save).not.toHaveBeenCalled();
});
