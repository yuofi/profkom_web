// @vitest-environment jsdom
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Link, Outlet, RouterProvider, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActionForm } from "./ActionForm";
import { UnsavedChangesProvider } from "./UnsavedChanges";
import { useConfirmedNavigation, useGuardedAction, useUnsavedChanges } from "./unsavedChangesHooks";
import { change, field, settle, submit } from "../../test/workspace";
import { ApiError } from "../../utils/api/request";
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); });
async function mount(editor: ReactNode, entries = ["/edit"]) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const client = new QueryClient();
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [
    { path: "/edit", element: editor }, { path: "/destination", element: <p>Страница назначения</p> },
  ] }], { initialEntries: entries });
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  cleanup = async () => { await act(async () => root.unmount()); router.dispose(); client.clear(); container.remove(); };
  return { container, router };
}
const button = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label);
  if (!found) throw Error(`Button missing: ${label}`); return found;
};
async function click(element: HTMLElement) { await act(async () => element.click()); await settle(); }
function Editor({ save = async () => {}, danger = false }: { save?: () => Promise<void>; danger?: boolean }) {
  return <><ActionForm fields={[{ name: "title", label: "Название", required: true, value: "Сохранено" }]} onSubmit={save} variant={danger ? "danger" : "primary"} /><Link to="/destination">Уйти</Link></>;
}
it("saves and leaves once", async () => {
  const save = vi.fn(async () => {}); const page = await mount(<Editor save={save} />);
  await change(field(page.container, "title"), "Новая редакция"); await click(page.container.querySelector("a")!);
  expect(page.router.state.location.pathname).toBe("/edit"); await click(button(page.container, "Сохранить и перейти"));
  expect(save).toHaveBeenCalledTimes(1); expect(page.container.textContent).toContain("Страница назначения");
});
it("failed save keeps typed text and blocked destination", async () => {
  const page = await mount(<Editor save={async () => { throw new ApiError("Конфликт версии", 409); }} />);
  await change(field(page.container, "title"), "Не терять текст"); await click(page.container.querySelector("a")!);
  await click(button(page.container, "Сохранить и перейти"));
  expect(page.router.state.location.pathname).toBe("/edit"); expect(field(page.container, "title").value).toBe("Не терять текст");
  expect(page.container.textContent).toContain("Изменения не сохранены");
});
it("validation failure stays without calling the server", async () => {
  const save = vi.fn(async () => {}); const page = await mount(<Editor save={save} />);
  await change(field(page.container, "title"), ""); await click(page.container.querySelector("a")!); await click(button(page.container, "Сохранить и перейти"));
  expect(save).not.toHaveBeenCalled(); expect(page.router.state.location.pathname).toBe("/edit");
});
it("guards POP/back and can stay or discard", async () => {
  const save = vi.fn(async () => {}); const page = await mount(<Editor save={save} />, ["/destination", "/edit"]);
  await change(field(page.container, "title"), "Черновик"); await act(async () => { await page.router.navigate(-1); });
  await click(button(page.container, "Остаться")); expect(page.router.state.location.pathname).toBe("/edit");
  await act(async () => { await page.router.navigate(-1); }); await click(button(page.container, "Уйти без сохранения"));
  expect(page.router.state.location.pathname).toBe("/destination"); expect(save).not.toHaveBeenCalled();
});
it.each(["discard", "save"])("can %s and leave again for the same Back/Forward history target", async (choice) => {
  const save = vi.fn(async () => {});
  const page = await mount(<Editor save={save} />, ["/destination", "/edit"]);
  let destinationKey: string | undefined;
  for (let cycle = 0; cycle < 2; cycle++) {
    await change(field(page.container, "title"), `Черновик ${cycle + 1}`);
    await act(async () => { await page.router.navigate(-1); });
    await click(button(page.container, choice === "save" ? "Сохранить и перейти" : "Уйти без сохранения"));
    expect(page.router.state.location.pathname).toBe("/destination");
    if (destinationKey) expect(page.router.state.location.key).toBe(destinationKey);
    else destinationKey = page.router.state.location.key;
    expect(page.container.querySelector("dialog")).toBeNull();
    if (cycle === 0) await act(async () => { await page.router.navigate(1); });
  }
  expect(save).toHaveBeenCalledTimes(choice === "save" ? 2 : 0);
});
it("allows anchors and warns before closing only while dirty", async () => {
  const page = await mount(<Editor />);
  const clean = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
  await change(field(page.container, "title"), "Черновик"); await act(async () => { await page.router.navigate("/edit#section"); });
  expect(page.router.state.location.hash).toBe("#section"); expect(page.container.querySelector("dialog")).toBeNull();
  const dirty = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(dirty); expect(dirty.defaultPrevented).toBe(true);
  await submit(page.container.querySelector("form")!);
  const saved = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(saved); expect(saved.defaultPrevented).toBe(false);
});
it("normal successful create can redirect without stale confirmation", async () => {
  function Create() { const navigate = useNavigate(); return <ActionForm fields={[{ name: "title", label: "Название", required: true }]} onSubmit={async () => { navigate("/destination"); }} />; }
  const page = await mount(<Create />); await change(field(page.container, "title"), "Новый черновик"); await submit(page.container.querySelector("form")!); await settle();
  expect(page.router.state.location.pathname).toBe("/destination"); expect(page.container.querySelector("dialog")).toBeNull();
});
it("marks notification after real navigation, not cancelled leave", async () => {
  const read = vi.fn(); function Notice() { const navigate = useConfirmedNavigation(); return <><Editor /><button onClick={() => navigate("/destination", read)}>Источник</button></>; }
  const page = await mount(<Notice />); await change(field(page.container, "title"), "Черновик"); await click(button(page.container, "Источник"));
  await click(button(page.container, "Остаться")); expect(read).not.toHaveBeenCalled(); await click(button(page.container, "Источник"));
  await click(button(page.container, "Уйти без сохранения")); expect(read).toHaveBeenCalledTimes(1);
});
it("includes external text and pending upload, preserving local edits on foreign revision", async () => {
  const save = vi.fn(async () => {});
  function External() { const [body, setBody] = useState("Сохранено"); const [busy, setBusy] = useState(false); const [server, setServer] = useState("Сохранено");
    return <><ActionForm fields={[]} externalState={body} savedExternalState={server} externalBusy={busy} onSubmit={save}><input value={body} onChange={(e) => setBody(e.target.value)} /></ActionForm>
      <button onClick={() => setServer("Чужая версия")}>Чужая версия</button><button onClick={() => setBusy(!busy)}>Загрузка</button><Link to="/destination">Уйти</Link></>; }
  const page = await mount(<External />); await change(page.container.querySelector("input")!, "Мой текст"); await click(button(page.container, "Чужая версия"));
  await click(button(page.container, "Загрузка")); await click(page.container.querySelector("a")!);
  expect(button(page.container, "Сохранить и перейти").disabled).toBe(true); expect(button(page.container, "Уйти без сохранения").disabled).toBe(true);
  await click(button(page.container, "Остаться")); await click(button(page.container, "Загрузка")); await click(page.container.querySelector("a")!);
  expect(page.container.querySelector("input")!.value).toBe("Мой текст"); await click(button(page.container, "Сохранить и перейти")); expect(save).toHaveBeenCalledTimes(1);
});
it("external file state cleared by successful submission becomes clean", async () => {
  function Submission() { const [files, setFiles] = useState<string[]>([]); return <><ActionForm fields={[]} externalState={files} savedExternalState={[]} resetOnSuccess onSubmit={async () => { setFiles([]); }}><button type="button" onClick={() => setFiles(["file-1"])}>Прикрепить</button></ActionForm><Link to="/destination">Уйти</Link></>; }
  const page = await mount(<Submission />); await click(button(page.container, "Прикрепить")); await submit(page.container.querySelector("form")!);
  await click(page.container.querySelector("a")!); expect(page.router.state.location.pathname).toBe("/destination"); expect(page.container.querySelector("dialog")).toBeNull();
});
it("never auto-executes destructive forms", async () => {
  const save = vi.fn(async () => {}); const page = await mount(<Editor save={save} danger />); await change(field(page.container, "title"), "Причина удаления");
  await click(page.container.querySelector("a")!); expect(button(page.container, "Сохранить и перейти").disabled).toBe(true);
  await click(button(page.container, "Уйти без сохранения")); expect(save).not.toHaveBeenCalled();
});
it("guards closing an editor dialog", async () => {
  const closed = vi.fn(); function DialogEditor() { const leave = useGuardedAction(); return <><Editor /><button onClick={() => leave(closed)}>Закрыть</button></>; }
  const page = await mount(<DialogEditor />); await change(field(page.container, "title"), "Черновик"); await click(button(page.container, "Закрыть"));
  await click(button(page.container, "Остаться")); expect(closed).not.toHaveBeenCalled(); await click(button(page.container, "Закрыть"));
  await click(button(page.container, "Сохранить и перейти")); expect(closed).toHaveBeenCalledTimes(1);
});

it("closing a clean or discarded password editor preserves unrelated profile edits", async () => {
  const closed = vi.fn();
  function ProfileWithPassword() {
    const [password, setPassword] = useState("");
    const close = useGuardedAction("password-editor");
    useUnsavedChanges({ dirty: !!password, scope: "password-editor", label: "Пароль", discard: () => setPassword("") });
    return <><Editor /><input aria-label="Новый пароль" value={password} onChange={(event) => setPassword(event.target.value)} />
      <button onClick={() => close(closed)}>Закрыть пароль</button></>;
  }
  const page = await mount(<ProfileWithPassword />);
  await change(field(page.container, "title"), "Несохранённый профиль");
  await click(button(page.container, "Закрыть пароль"));
  expect(closed).toHaveBeenCalledTimes(1); expect(page.container.querySelector("dialog")).toBeNull();
  await change(page.container.querySelector<HTMLInputElement>('[aria-label="Новый пароль"]')!, "test-only-draft");
  await click(button(page.container, "Закрыть пароль"));
  await click(button(page.container, "Уйти без сохранения"));
  expect(closed).toHaveBeenCalledTimes(2);
  expect(field(page.container, "title").value).toBe("Несохранённый профиль");
  expect(page.container.querySelector<HTMLInputElement>('[aria-label="Новый пароль"]')!.value).toBe("");
  await click(page.container.querySelector("a")!);
  expect(page.container.querySelector("dialog")).not.toBeNull();
});

it("saves the latest registered callback after parent rerenders with unchanged guard status", async () => {
  const saved: number[] = [];
  function Probe() {
    const [value, setValue] = useState(0);
    useUnsavedChanges({ dirty: true, busy: false, label: "Одна и та же форма", save: async () => { saved.push(value);return true; } });
    return <><output>{value}</output><button onClick={() => setValue(previous => previous + 1)}>Изменить значение</button><Link to="/destination">Уйти</Link></>;
  }
  const page = await mount(<Probe />);
  for (let index = 0; index < 4; index++) await click(button(page.container, "Изменить значение"));
  expect(page.container.querySelector("output")?.textContent).toBe("4");await click(page.container.querySelector("a")!);
  await click(button(page.container, "Сохранить и перейти"));expect(saved).toEqual([4]);expect(page.router.state.location.pathname).toBe("/destination");
});

it("retries a failed leave-save using a replacement callback even when dirty, busy and label stay equal", async () => {
  const attempts: string[] = [];let replaceValue: (value: string) => void = () => {};
  function Probe() {
    const [value, setValue] = useState("old");useEffect(() => { replaceValue = setValue; }, []);
    useUnsavedChanges({ dirty: true, busy: false, label: "Черновик", save: async () => { attempts.push(value);return value === "fresh"; } });
    return <><output>{value}</output><Link to="/destination">Уйти</Link></>;
  }
  const page = await mount(<Probe />);await click(page.container.querySelector("a")!);await click(button(page.container, "Сохранить и перейти"));
  expect(attempts).toEqual(["old"]);expect(page.router.state.location.pathname).toBe("/edit");expect(page.container.querySelector("dialog")?.textContent).toContain("Изменения не сохранены");
  await act(async () => replaceValue("fresh"));await settle();await click(button(page.container, "Сохранить и перейти"));
  expect(attempts).toEqual(["old", "fresh"]);expect(page.router.state.location.pathname).toBe("/destination");
});

it("removes a registration on unmount and uses only the remounted editor's latest discard callback", async () => {
  const discarded: number[] = [];const saved = vi.fn(async () => true);
  function Registration({ version }: { version: number }) {
    useUnsavedChanges({ dirty: true, busy: false, label: "Одна и та же форма", save: saved, discard: () => discarded.push(version) });return <output>{version}</output>;
  }
  function Probe() {
    const [visible, setVisible] = useState(true), [version, setVersion] = useState(0);
    return <>{visible && <Registration version={version} />}<button onClick={() => setVisible(value => !value)}>Переключить редактор</button><button onClick={() => setVersion(value => value + 1)}>Обновить редактор</button><Link to="/destination">Уйти</Link></>;
  }
  const page = await mount(<Probe />);
  await click(button(page.container, "Переключить редактор"));const removed = new Event("beforeunload", { cancelable: true });window.dispatchEvent(removed);expect(removed.defaultPrevented).toBe(false);
  await click(button(page.container, "Обновить редактор"));await click(button(page.container, "Переключить редактор"));
  for (let index = 0; index < 3; index++) await click(button(page.container, "Обновить редактор"));
  const restored = new Event("beforeunload", { cancelable: true });window.dispatchEvent(restored);expect(restored.defaultPrevented).toBe(true);
  await click(page.container.querySelector("a")!);await click(button(page.container, "Уйти без сохранения"));
  expect(discarded).toEqual([4]);expect(saved).not.toHaveBeenCalled();expect(page.router.state.location.pathname).toBe("/destination");
  const exited = new Event("beforeunload", { cancelable: true });window.dispatchEvent(exited);expect(exited.defaultPrevented).toBe(false);
});

it("updates an open leave prompt when the label, save availability and busy state change", async () => {
  type Status = { label: string; canSave: boolean; busy: boolean };
  let refresh: (next: Status) => void = () => {};const saved: string[] = [];
  function Probe() {
    const [status, setStatus] = useState<Status>({ label: "Первый редактор", canSave: false, busy: false });useEffect(() => { refresh = setStatus; }, []);
    useUnsavedChanges({ dirty: true, busy: status.busy, label: status.label, save: status.canSave ? async () => { saved.push(status.label);return true; } : undefined });
    return <Link to="/destination">Уйти</Link>;
  }
  const page = await mount(<Probe />);await click(page.container.querySelector("a")!);
  expect(button(page.container, "Сохранить и перейти").disabled).toBe(true);expect(button(page.container, "Уйти без сохранения").disabled).toBe(false);
  await act(async () => refresh({ label: "Текущий редактор", canSave: true, busy: false }));await settle();
  expect(button(page.container, "Сохранить и перейти").disabled).toBe(false);expect(page.container.querySelector("dialog")?.textContent).toContain("Текущий редактор");
  expect(page.container.querySelector("dialog")?.textContent).not.toContain("Первый редактор");
  await act(async () => refresh({ label: "Текущий редактор", canSave: true, busy: true }));await settle();
  expect(button(page.container, "Сохранить и перейти").disabled).toBe(true);expect(button(page.container, "Уйти без сохранения").disabled).toBe(true);
  await act(async () => refresh({ label: "Текущий редактор", canSave: true, busy: false }));await settle();await click(button(page.container, "Сохранить и перейти"));
  expect(saved).toEqual(["Текущий редактор"]);expect(page.router.state.location.pathname).toBe("/destination");
});
