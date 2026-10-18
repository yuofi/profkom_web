// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change, field, submit } from "../../test/workspace";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { EventPage } from "./EventPages";
import { BlockPage } from "./MembershipPages";
import { AccountStatePage } from "./SessionPages";
import { MeetingPage } from "./ReportPages";
import { SeasonPage, SummaryPage } from "./SeasonPages";
import { seasonsApi } from "../../utils/api/seasons.api";
import { QueryState } from "../../components/Workspace/WorkspaceUI";
import { ApiError } from "../../utils/api/request";
import { MeritForm } from "./MeritPages";
import { AvatarPicker } from "../../components/Workspace/AvatarPicker";
import { filesApi } from "../../utils/api/files.api";
import { MaterialsPage } from "./MaterialPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

async function clickButton(container: ParentNode, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!button) throw Error(`Missing button: ${text}`);
  await act(async () => button.click()); await settle();
}
const acknowledge = (form: HTMLFormElement) => clickButton(form, "Сохранить мой ввод с обновлённой версией");

it.each(["event", "block", "registration", "meeting", "season", "decisions"] as const)("A05: %s retains its draft through 409, refresh, consent and retry", async (kind) => {
  const role = kind === "registration" ? "pending" : "chair";
  mock = installMockTransport(role, { delay: 0 });
  const routes = {
    event: ["/events/event-1", "/events/:id", <EventPage />, "description"],
    block: [`/blocks/${mock.state.blocks[0].block_id}`, "/blocks/:id", <BlockPage />, "body"],
    registration: ["/", "/", <AccountStatePage />, "phone"],
    meeting: ["/meetings/subevent/subevent-1", "/meetings/:kind/:id", <MeetingPage />, "title"],
    season: ["/seasons/season-1", "/seasons/:id", <SeasonPage />, "title"],
    decisions: ["/seasons/season-1/summary", "/seasons/:id/summary", <SummaryPage />, "reason"],
  } as const;
  const [path, route, element, name] = routes[kind];
  page = await mountWorkspace(<Routes><Route path={route} element={element} /></Routes>, { role, path });
  await settle(); await settle();
  const form = kind === "event" ? Array.from(page.container.querySelectorAll("form")).find((f) => f.querySelector<HTMLInputElement>('[name="title"]')?.value === mock!.state.events[0].title && f.querySelector('[name="description"]'))! : field(page.container, name).closest("form")!;
  await change(field(form, name), "МОЙ НЕСОХРАНЁННЫЙ ТЕКСТ");
  if (kind === "season") await change(field(form, "reason"), "Уточнение плановых дат");
  const record = kind === "event" ? mock.state.events[0] : kind === "block" ? mock.state.blocks[0] : kind === "registration" ? mock.state.registration : kind === "meeting" ? mock.state.meetings[0] : mock.state.seasons.find((s) => s.season_id === "season-1")!;
  let latestRevision: number;
  if (kind === "decisions") latestRevision = (await seasonsApi.decisions("season-1", mock.state.people[0].user_id!, { expected_version: 1, decisions: [], reason: "Другой редактор" })).version;
  else latestRevision = ++record.revision;
  await submit(form);
  expect(form.querySelector('[role="alert"]'), page.container.textContent ?? "").not.toBeNull();
  await clickButton(form, "Обновить данные");
  expect(form.isConnected).toBe(true);
  expect(field(form, name).value).toBe("МОЙ НЕСОХРАНЁННЫЙ ТЕКСТ");
  const mutations = () => [...mock!.adapter.history.post, ...mock!.adapter.history.patch, ...mock!.adapter.history.put].filter((r) => r.data && /expected_revision|expected_version/.test(r.data));
  const beforeConsent = mutations().length;
  await submit(form);
  expect(mutations()).toHaveLength(beforeConsent);
  await acknowledge(form);
  await submit(form);
  expect(mutations()).toHaveLength(beforeConsent + 1);
  const payload = JSON.parse(mutations().at(-1)!.data);
  expect(payload.expected_revision ?? payload.expected_version).toBe(latestRevision);
  expect(form.querySelector('[role="alert"]'), page.container.textContent ?? "").toBeNull();
});

it("A05: background revisions do not silently authorize overwriting a draft", async () => {
  const save = vi.fn(async () => {});
  function Probe() {
    const [revision, setRevision] = useState(1);
    return <><button onClick={() => setRevision(2)}>External update</button><ActionForm revision={revision} fields={[{ name: "title", label: "Название", value: revision === 1 ? "Старое" : "Серверное" }]} onSubmit={save} /></>;
  }
  page = await mountWorkspace(<Probe />);
  await change(field(page.container, "title"), "Мой черновик");
  await clickButton(page.container, "External update");
  const form = page.container.querySelector("form")!;
  expect(form.textContent).toContain("Серверное");
  expect(field(form, "title").value).toBe("Мой черновик");
  await submit(form);
  expect(save).not.toHaveBeenCalled();
  await acknowledge(form); await submit(form);
  expect(save).toHaveBeenCalledWith({ title: "Мой черновик" }, 2);
});

it("A05: a failed refresh retains the same editor; a denied read removes it", async () => {
  function Probe() {
    const [error, setError] = useState<unknown>(null);
    return <><button onClick={() => setError(new ApiError("Сеть недоступна", 503))}>Network error</button><button onClick={() => setError(new ApiError("Нет доступа", 403))}>Revoke</button><QueryState loading={false} error={error} keepDataOnError><ActionForm fields={[{ name: "title", label: "Название" }]} onSubmit={async () => {}} /></QueryState></>;
  }
  page = await mountWorkspace(<Probe />);
  const form = page.container.querySelector("form");
  await change(field(page.container, "title"), "Мой ввод");
  await clickButton(page.container, "Network error");
  expect(page.container.querySelector("form")).toBe(form);
  expect(field(page.container, "title").value).toBe("Мой ввод");
  await clickButton(page.container, "Revoke");
  expect(page.container.querySelector("form")).toBeNull();
});

async function meritBase(container: HTMLElement) {
  for (const [name, value] of Object.entries({ title: "Помощь", body: "Выполненная работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", reason: "Учёт выполненного" })) await change(field(container, name), value);
}
it("A06: selected missing recipients keep their fields and values until explicitly deselected", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<MeritForm seasonId="season-1" initialSource="block_volunteer" initialScopeId={mock.state.blocks[0].block_id} />);
  await settle(); await settle();
  const ids = mock.state.people.slice(0, 3).map((p) => p.user_id!);
  for (const id of ids.slice(0, 2)) await act(async () => page!.container.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${id}"]`)!.click());
  await meritBase(page.container);
  for (const id of ids.slice(0, 2)) { await change(field(page.container, `hours_${id}`), "7"); await change(field(page.container, `evaluation_${id}`), "0"); }
  await change(field(page.container, `evaluation_${ids[0]}`), "1");
  await change(field(page.container, `completed_${ids[0]}`), "2026-10-05T13:00");
  const contacts = page.client.getQueryData<{ user_id: number }[]>(["contacts"])!;
  await act(async () => page!.client.setQueryData(["contacts"], contacts.filter((p) => p.user_id !== ids[0] && p.user_id !== ids[2])));
  await settle();
  expect(field(page.container, `hours_${ids[0]}`).value).toBe("7");
  expect(field(page.container, `evaluation_${ids[0]}`).value).toBe("1");
  expect(field(page.container, `completed_${ids[0]}`).value).toBe("2026-10-05T13:00");
  expect(page.container.textContent).toContain("нет в актуальном справочнике");
  expect(page.container.querySelector(`input[type="checkbox"][value="${ids[2]}"]`)).toBeNull();
  await submit(page.container.querySelector("form")!);
  expect(mock.state.merits[0].recipients.map((r) => r.user_id)).toEqual(ids.slice(0, 2));
  await act(async () => page!.client.setQueryData(["contacts"], contacts.filter((p) => p.user_id !== ids[0]))); await settle();
  await act(async () => page!.container.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${ids[0]}"]`)!.click());
  expect(page.container.querySelector(`[name="hours_${ids[0]}"]`)).toBeNull();
  await submit(page.container.querySelector("form")!);
  expect(mock.state.merits[1].recipients.map((r) => r.user_id)).toEqual([ids[1]]);
});

it("A06: a newly fetched recipient gets valid empty optional fields", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<MeritForm seasonId="season-1" initialScopeId={mock.state.blocks[0].block_id} />);
  await settle(); await settle();
  const contacts = page.client.getQueryData<object[]>(["contacts"])!;
  const template = contacts[0];
  await act(async () => page!.client.setQueryData(["contacts"], [...contacts, { ...template, user_id: 9999, in_profcom: true }])); await settle();
  await act(async () => page!.container.querySelector<HTMLInputElement>('input[type="checkbox"][value="9999"]')!.click());
  expect(field(page.container, "completed_9999").value).toBe("");
  await meritBase(page.container);
  await change(field(page.container, "hours_9999"), "2"); await change(field(page.container, "evaluation_9999"), "0");
  await submit(page.container.querySelector("form")!);
  expect(mock.state.merits[0].recipients).toEqual([{ user_id: 9999, hours: 2, evaluation: 0, completed_at: null }]);
});

it.each([
  [6 * 1024 * 1024, "image/jpeg", true],
  [10 * 1024 * 1024 - 1, "image/png", true],
  [10 * 1024 * 1024, "image/webp", true],
  [10 * 1024 * 1024 + 1, "image/jpeg", false],
  [100, "text/html", false],
])("A07: photo size %i / %s reaches upload intent only when allowed", async (size, mime, allowed) => {
  mock = installMockTransport("organizer", { delay: 0 });
  const intent = vi.spyOn(filesApi, "intent");
  page = await mountWorkspace(<AvatarPicker />, { role: "organizer" }); await settle();
  const input = page.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [new File([new Uint8Array(size)], "size-probe", { type: mime })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true }))); await settle(); await settle();
  if (allowed) {
    expect(intent).toHaveBeenCalledWith(expect.objectContaining({ size_bytes: size, mime_type: mime, owner_kind: "avatar" }));
    expect(page.container.textContent).toContain("Аватар сохранён");
  } else {
    expect(intent).not.toHaveBeenCalled();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("до 10 МиБ");
  }
});

it("A09: empty filtered materials explain the result and reset search and kind together", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  mock.state.materials.push({ ...mock.state.materials[0], material_id: "general-test", title: "Общий документ", kind: "general" });
  page = await mountWorkspace(<MaterialsPage />, { role: "organizer" }); await settle();
  await change(page.container.querySelector("select")!, "general");
  await change(page.container.querySelector("input")!, "НЕСУЩЕСТВУЮЩИЙ МАТЕРИАЛ");
  expect(page.container.textContent).toContain("Ничего не найдено");
  expect(page.container.querySelector("h2")).toBeNull();
  await clickButton(page.container, "Сбросить фильтры");
  expect(page.container.querySelector("select")!.value).toBe("");
  expect(page.container.querySelector("input")!.value).toBe("");
  expect(page.container.textContent).toContain("Общий документ");
  expect(page.container.textContent).toContain(mock.state.materials[0].title);
});

it("A09: an empty catalogue differs from a filtered result and an error", async () => {
  mock = installMockTransport("organizer", { delay: 0 }); mock.state.materials.length = 0;
  page = await mountWorkspace(<MaterialsPage />, { role: "organizer" }); await settle();
  expect(page.container.textContent).toContain("Материалы готовятся");
  expect(page.container.textContent).not.toContain("Ничего не найдено");
  await page.cleanup(); page = undefined; mock.restore();
  mock = installMockTransport("organizer", { delay: 0, scenario: "error" });
  page = await mountWorkspace(<MaterialsPage />, { role: "organizer" }); await settle();
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Сервис временно недоступен");
  expect(page.container.textContent).not.toMatch(/Материалы готовятся|Ничего не найдено/);
});

it("A09: initial loading does not claim that the catalogue is empty", async () => {
  mock = installMockTransport("organizer", { delay: 40 });
  page = await mountWorkspace(<MaterialsPage />, { role: "organizer" });
  expect(page.container.textContent).toContain("Загружаем данные");
  expect(page.container.textContent).not.toMatch(/Материалы готовятся|Ничего не найдено/);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 65)));
  expect(page.container.querySelector("h2")).not.toBeNull();
});
