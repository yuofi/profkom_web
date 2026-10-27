// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, change, submit, waitForPage } from "../../test/workspace";
import { EntityPicker, type EntityOption } from "./EntityPicker";
import { ActionForm } from "./ActionForm";
import { usePeopleOptions } from "../../utils/hooks/useWorkspace";
import { useScopeMembers } from "./ScopeMembers";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
import { createFixtures } from "../../mocks/fixtures";
import { ApiError } from "../../utils/api/request";
import { UserChip } from "./UserChip";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks();document.querySelectorAll("dialog[data-picker-test]").forEach(node => node.remove()); });
const options: EntityOption[] = [
  { value: "11", label: "Анна Иванова", user: { user_id: 11, display_name: "Анна Иванова", avatar_url: "/avatars/leaf.svg" } },
  { value: "12", label: "Анна Иванова", user: { user_id: 12, display_name: "Анна Иванова", avatar_url: null } },
  { value: "13", label: "Мария Соколова", user: { user_id: 13, display_name: "Мария Соколова", avatar_url: null } },
  { value: "blocked", label: "Недоступный вариант", disabled: true },
];
const input = () => page!.container.querySelector<HTMLInputElement>('[role="combobox"]')!;
const choices = () => [...document.querySelectorAll<HTMLElement>('[data-entity-picker-popup] [role="option"]')];
async function open() { await act(async () => { input().focus();input().click(); });await waitForPage(page!); }
async function choose(value: string) { const option = choices().find(node => node.dataset.optionValue === value);expect(option).toBeDefined();await act(async () => option!.click());await waitForPage(page!); }
async function press(key: string) { await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));await waitForPage(page!); }
async function click(button: HTMLButtonElement) { await act(async () => button.click());await waitForPage(page!); }
function Single({ initial = "", available = options, disabled = false }: { initial?: string; available?: EntityOption[]; disabled?: boolean }) { const [value, setValue] = useState(initial);return <EntityPicker name="person" label="Исполнитель" entity="person" value={value} onChange={setValue} options={available} disabled={disabled} />; }

it("searches supplied people, renders avatar chips and saves exact IDs for identical names without profile navigation or directory reads", async () => {
  const contacts = vi.spyOn(directoryApi, "contacts");page = await mountWorkspace(<Single />);await open();await change(input(), "Анна");expect(choices()).toHaveLength(2);expect(choices().every(option => !!option.querySelector("img"))).toBe(true);
  expect(choices().some(option => option.querySelector("a"))).toBe(false);await choose("12");expect(page.container.querySelector<HTMLInputElement>('input[type="hidden"][name="person"]')?.value).toBe("12");expect(input().getAttribute("aria-expanded")).toBe("false");expect(contacts).not.toHaveBeenCalled();expect(page.container.querySelector("a")).toBeNull();
  // Focus is retained after choosing: another mouse click must reopen the popup.
  await act(async () => input().click());expect(choices()).toHaveLength(4);await press("Escape");expect(document.activeElement).toBe(input());expect(choices()).toHaveLength(0);
});
it("supports arrows, Home/End, Enter, Escape and skips disabled options", async () => {
  page = await mountWorkspace(<Single />);await open();expect(input().getAttribute("aria-activedescendant")).toBe(choices()[0].id);await press("End");expect(input().getAttribute("aria-activedescendant")).toBe(choices()[2].id);await press("ArrowDown");expect(input().getAttribute("aria-activedescendant")).toBe(choices()[0].id);await press("ArrowUp");expect(input().getAttribute("aria-activedescendant")).toBe(choices()[2].id);await press("Home");await press("Enter");expect(page.container.querySelector<HTMLInputElement>('input[name="person"]')?.value).toBe("11");
  await open();await change(input(), "нет совпадений");expect(document.querySelector('[data-entity-picker-popup]')?.textContent).toContain("Подходящих вариантов нет");expect(input().hasAttribute("aria-activedescendant")).toBe(false);await press("Escape");expect(input().value).toBe("");expect(page.container.querySelector<HTMLInputElement>('input[name="person"]')?.value).toBe("11");
});
it("multi-selects, removes chips, retains missing IDs without cached names and never saves arbitrary search text", async () => {
  function Probe() { const [value, setValue] = useState(["11", "gone"]), [available, setAvailable] = useState(options);return <><button onClick={() => setAvailable(options.filter(option => option.value !== "11"))}>Отозвать вариант</button><EntityPicker multiple name="people" label="Исполнители" entity="person" options={available} value={value} onChange={setValue} /></>; }
  page = await mountWorkspace(<Probe />);await open();await change(input(), "Мария");await choose("13");expect([...page.container.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="people"]')].map(node => node.value)).toEqual(["11", "gone", "13"]);
  await change(input(), "Несуществующий человек");await press("Enter");expect(page.container.querySelectorAll('[data-selected-value]')).toHaveLength(3);
  await click([...page.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Отозвать вариант")!);expect(page.container.textContent).not.toContain("Анна Иванова");expect(page.container.textContent).toContain("Выбранный участник недоступен");expect(page.container.querySelector('[data-selected-value="11"]')).not.toBeNull();
  await click(page.container.querySelector<HTMLButtonElement>('[data-selected-value="gone"] button')!);expect([...page.container.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="people"]')].map(node => node.value)).toEqual(["11", "13"]);
});
it("block and mixed-scope chips preserve opaque values and honest metadata without invented IDs", async () => {
  const values: EntityOption[] = [{ value: "name-only", label: "Инфо", block: { name: "Инфо" } }, { value: "subevent:uuid", label: "Встреча", scope: { kind: "subevent", name: "Встреча" } }];page = await mountWorkspace(<Single available={values} />);await open();expect(choices()[0].textContent).toContain("И");expect(choices()[0].querySelector("a,button")).toBeNull();expect(choices()[1].querySelector('[data-icon="event"]')).not.toBeNull();await choose("subevent:uuid");expect(page.container.querySelector<HTMLInputElement>('input[name="person"]')?.value).toBe("subevent:uuid");
});
it("portals into the current dialog, bounds the popup and closes on outside pointer or disabled fieldset", async () => {
  function Probe() { const [disabled, setDisabled] = useState(false);return <dialog open data-picker-test><button onClick={() => setDisabled(true)}>Заблокировать</button><fieldset disabled={disabled}><Single /></fieldset></dialog>; }
  page = await mountWorkspace(<Probe />);await open();const popup = document.querySelector<HTMLElement>('[data-entity-picker-popup]')!;expect(popup.parentElement?.tagName).toBe("DIALOG");expect(Number.parseFloat(popup.style.width)).toBeLessThanOrEqual(window.innerWidth - 16);expect(Number.parseFloat(popup.style.maxHeight)).toBeLessThanOrEqual(320);
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));expect(choices()).toHaveLength(0);await open();await click([...page.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Заблокировать")!);expect(input().matches(":disabled")).toBe(true);expect(choices()).toHaveLength(0);
});
it("disabled and loading states are accessible and cannot select a disabled option", async () => {
  const changeValue = vi.fn();page = await mountWorkspace(<EntityPicker label="Участник" value="11" onChange={changeValue} options={options} disabled loading invalid describedBy="explain" />);expect(input().disabled).toBe(true);expect(input().getAttribute("aria-invalid")).toBe("true");expect(input().getAttribute("aria-describedby")).toBe("explain");await act(async () => input().click());expect(choices()).toHaveLength(0);expect(changeValue).not.toHaveBeenCalled();
  await page.cleanup();page = undefined;page = await mountWorkspace(<EntityPicker label="Участник" value="" onChange={changeValue} options={options} loading />);await open();expect(document.querySelector('[data-entity-picker-popup] [role="status"]')?.textContent).toContain("Загружаем");await choose("blocked");expect(changeValue).not.toHaveBeenCalled();
});
it("visual UserChip selection mode has no links, focus target, profile tooltip or query", async () => {
  const query = vi.spyOn(directoryApi, "contacts");page = await mountWorkspace(<UserChip user={options[0].user!} interactive={false} />);expect(page.container.querySelector("a,button,[tabindex]")).toBeNull();expect(page.container.querySelector("img")?.getAttribute("src")).toBe("/avatars/leaf.svg");expect(query).not.toHaveBeenCalled();
});
it("ActionForm uses entity metadata only for entity fields, keeps enum selects native and submits IDs", async () => {
  const save = vi.fn(async () => {});page = await mountWorkspace(<ActionForm fields={[{ name: "person", label: "Исполнитель", type: "select", options, required: true }, { name: "status", label: "Статус", type: "select", options: [{ value: "open", label: "Открыта" }] }]} onSubmit={save} />);expect(page.container.querySelectorAll('[role="combobox"]')).toHaveLength(1);expect(page.container.querySelector('select[name="status"]')).not.toBeNull();await open();await choose("12");await submit(page.container.querySelector("form")!);expect(save).toHaveBeenCalledWith({ person: "12", status: "" }, undefined);
});
it("ActionForm retains multi-removal confirmation, exact saved IDs and clears successful creation selections", async () => {
  const save = vi.fn(async () => {});page = await mountWorkspace(<ActionForm fields={[{ name: "people", label: "Заместители", type: "multi", entity: "person", value: ["11", "12"], options }]} onSubmit={save} />);await click(page.container.querySelector<HTMLButtonElement>('[data-selected-value="11"] button')!);await submit(page.container.querySelector("form")!);expect(save).not.toHaveBeenCalled();expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Будут сняты: Анна Иванова");await click([...page.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Снять и сохранить")!);expect(save).toHaveBeenCalledWith({ people: ["12"] }, undefined);
  await page.cleanup();page = undefined;page = await mountWorkspace(<ActionForm resetOnSuccess fields={[{ name: "people", label: "Новые участники", type: "multi", entity: "person", options }]} onSubmit={save} />);await open();await choose("13");await submit(page.container.querySelector("form")!);expect(page.container.querySelectorAll('[data-selected-value]')).toHaveLength(0);
});
it("a refused entity save preserves selection, and stale revisions cannot save without explicit consent", async () => {
  let revision = 1;const save = vi.fn(async (_values: unknown, expected?: number) => { if (expected !== revision) throw new ApiError("Changed", 409, "revision_conflict");return { revision: ++revision }; });
  function Probe() { const [seen, setSeen] = useState(1);return <><button onClick={() => { revision++;setSeen(revision); }}>Чужая версия</button><ActionForm revision={seen} onConflict={() => setSeen(revision)} fields={[{ name: "person", label: "Исполнитель", type: "select", entity: "person", options, value: "11" }]} onSubmit={save} /></>; }
  page = await mountWorkspace(<Probe />);await open();await choose("13");await click([...page.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Чужая версия")!);await submit(page.container.querySelector("form")!);expect(save).not.toHaveBeenCalled();expect(page.container.querySelector<HTMLInputElement>('input[name="person"]')?.value).toBe("13");await click([...page.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Сохранить мой ввод с обновлённой версией")!);await submit(page.container.querySelector("form")!);expect(save).toHaveBeenCalledWith({ person: "13" }, 2);
});
it("people metadata comes from current directory projection and scoped members still restrict the candidate IDs", async () => {
  const fixture = createFixtures("chair");const contacts = fixture.people.map((person, index) => ({ user_id: person.user_id!, surname: person.display_name.split(" ")[0], name: person.display_name.split(" ").slice(1).join(" "), patronymic: "", kkr_name: "", group_number: "301", location: "", blocks: "", phone: "", vk: "", tg: "", email: "", budget: true, in_profcom: index !== 2, photo_url: person.avatar_url ?? undefined }));
  vi.spyOn(directoryApi, "contacts").mockResolvedValue(contacts);const block = fixture.blocks[0];block.members = [{ user: fixture.people[0], block_category: "member" }];block.master = null;vi.spyOn(membershipApi, "block").mockResolvedValue(block);
  function Probe() { const all = usePeopleOptions(), scoped = useScopeMembers({ kind: "block", id: block.block_id });return <><output aria-label="all">{all.options.map(option => `${option.value}:${option.user?.user_id}`).join(",")}</output><output aria-label="scoped">{scoped.options.map(option => `${option.value}:${option.user?.user_id}`).join(",")}</output></>; }
  page = await mountWorkspace(<Probe />);await waitForPage(page);expect(page.container.querySelector('[aria-label="all"]')?.textContent).not.toContain(String(fixture.people[2].user_id));expect(page.container.querySelector('[aria-label="scoped"]')?.textContent).toBe(`${fixture.people[0].user_id}:${fixture.people[0].user_id}`);
});
