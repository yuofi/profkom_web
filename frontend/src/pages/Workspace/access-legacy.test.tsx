// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createFixtures } from "../../mocks/fixtures";
import { afterEach, expect, it } from "vitest";
import { AxiosError } from "axios";
import MockAdapter from "axios-mock-adapter";
import { z } from "zod";
import { api } from "../../utils/api";
import { useForm } from "../../components/Form/Form";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change, field, pick, submit } from "../../test/workspace";
import { AdminPanel } from "../Admin/AdminPage";
import { BlocksPage } from "./MembershipPages";
import { EventsListPage } from "./EventPages";
import { EventPage } from "./EventPages";
import { BlockPage } from "./MembershipPages";
import { MeritsPage, MeritEntryPage } from "./MeritPages";
import { SessionContext } from "../../utils/session";
import { LeadershipPage } from "./SessionPages";
import { ProfileEditPage } from "../ProfileEditPage/ProfileEditPage";
import { UserContext } from "../../utils/me";
import { HelmetProvider } from "react-helmet-async";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; restore?.(); restore = undefined; });

it.each([
  ["users", "Регистрации"], ["blocks", "Блоки"], ["events", "Мероприятия"],
])("A01: old admin/%s opens the current domain screen", async (tab, title) => {
  const mock = installMockTransport("chair", { delay: 0 }); restore = mock.restore;
  page = await mountWorkspace(
    <Routes>
      <Route path="/admin/:tab" element={<AdminPanel />} />
      <Route path="/blocks" element={<BlocksPage />} />
      <Route path="/events" element={<EventsListPage />} />
    </Routes>,
    { path: `/admin/${tab}` },
  );
  await settle(); await settle();
  expect(page.container.querySelector("h1")?.textContent).toContain(title);
  expect(page.container.textContent).not.toContain("Добавить блок");
  expect(mock.adapter.history.patch).toHaveLength(0);
  expect(mock.adapter.history.post).toHaveLength(0);
});

it.each([403, 409, 422])("A02: retained form renders structured %i and preserves input", async (status) => {
  function Probe() {
    const { formik, globalError } = useForm({
      initialValues: { title: "" }, validationSchema: z.object({ title: z.string() }),
      onSubmit: async () => { throw new AxiosError("request failed", undefined, undefined, undefined, {
        status, statusText: "Error", headers: {}, config: { headers: {} } as never,
        data: { detail: { code: "invalid_input", message: "Invalid title", fields: { title: "Уточните название" } } },
      }); },
    });
    return <form onSubmit={formik.handleSubmit}><input {...formik.getFieldProps("title")} />
      <p role="alert">{globalError}</p><span>{formik.errors.title}</span><button type="submit">Отправить</button></form>;
  }
  page = await mountWorkspace(<Probe />);
  await change(field(page.container, "title"), "Мой черновик");
  await submit(page.container.querySelector("form")!);
  // The text comes from the code; the server's English message stays out (2.13).
  expect(page.container.textContent).toContain("Проверьте введённые данные.");
  expect(page.container.textContent).not.toContain("Invalid title");
  expect(page.container.textContent).toContain("Уточните название");
  expect(field(page.container, "title").value).toBe("Мой черновик");
});

it("A02: adapter errors and FastAPI field errors use the same normalizer", async () => {
  const adapter = new MockAdapter(api); restore = () => adapter.restore();
  adapter.onPost("/form-error").reply(422, { detail: [{ loc: ["body", "title"], msg: "Нужно название" }] });
  function Probe() {
    const { formik, globalError } = useForm({ initialValues: { title: "draft" }, validationSchema: z.object({ title: z.string() }), onSubmit: async () => { await api.post("/form-error"); } });
    return <form onSubmit={formik.handleSubmit}><input {...formik.getFieldProps("title")} /><p role="alert">{globalError}</p><span>{formik.errors.title}</span><button type="submit">Отправить</button></form>;
  }
  page = await mountWorkspace(<Probe />);
  await submit(page.container.querySelector("form")!);
  expect(page.container.textContent).toContain("Проверьте введённые данные.");
  expect(page.container.textContent).toContain("Нужно название");
  expect(page.container.textContent).not.toContain("Request failed");
});

async function fillMerit(container: HTMLElement, userId: number) {
  await pick(container, "users", String(userId));
  for (const [name, value] of Object.entries({ title: "Помощь", body: "Выполненная работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", reason: "Подтверждено руководителем", [`hours_${userId}`]: "4", [`evaluation_${userId}`]: "0" })) await change(field(container, name), value);
  await submit(container.querySelector("form")!);
}

it("A04: a master without summary access finds and submits the scoped volunteer form", async () => {
  const mock = installMockTransport("leader", { delay: 0 }); restore = mock.restore;
  const block = mock.state.blocks[0];
  page = await mountWorkspace(<Routes>
    <Route path="/blocks/:id" element={<BlockPage />} />
    <Route path="/merits" element={<MeritEntryPage />} />
    <Route path="/seasons/:id/merits" element={<MeritsPage />} />
  </Routes>, { role: "leader", path: `/blocks/${block.block_id}` });
  await settle(); await settle();
  await act(async () => Array.from(page!.container.querySelectorAll("a")).find((a) => a.textContent === "Учесть волонтёрскую работу")!.click());
  await settle(); await settle();
  expect(page.container.textContent).not.toContain("Сводная ККР");
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href*="/seasons/season-1/merits"]')!.click());
  await settle(); await settle();
  expect(field(page.container, "scope").value).toBe(block.block_id);
  await fillMerit(page.container, mock.state.people[0].user_id!);
  expect(mock.state.merits).toHaveLength(1);
  expect(mock.state.merits[0]).toMatchObject({ source_kind: "block_volunteer", season_id: "season-1", scope: { kind: "block", id: block.block_id } });
  expect(mock.adapter.history.get.some((r) => /summary|assessments|master-bonuses/.test(r.url ?? ""))).toBe(false);
});

it("A04: an event head with only object permission can submit head merit", async () => {
  const mock = installMockTransport("leader", { delay: 0 }); restore = mock.restore;
  const session = { ...mock.state.session, capabilities: mock.state.session.capabilities.filter((c) => !["create_volunteer_merit", "view_summary"].includes(c)) };
  page = await mountWorkspace(<SessionContext.Provider value={{ session, loading: false, error: null, refresh: () => {} }}><Routes>
    <Route path="/events/:id" element={<EventPage />} />
    <Route path="/seasons/:id/merits" element={<MeritsPage />} />
  </Routes></SessionContext.Provider>, { role: "leader", path: "/events/event-1" });
  await settle(); await settle();
  await act(async () => Array.from(page!.container.querySelectorAll("a")).find((a) => a.textContent === "Учесть особую заслугу")!.click());
  await settle(); await settle();
  expect(page.container.querySelectorAll("select")[0].value).toBe("head_merit");
  expect(field(page.container, "scope").value).toBe("event-1");
  await fillMerit(page.container, mock.state.people[0].user_id!);
  expect(mock.state.merits[0]).toMatchObject({ source_kind: "head_merit", season_id: "season-1", event_id: "event-1" });
  expect(mock.adapter.history.get.some((r) => /summary|assessments|master-bonuses/.test(r.url ?? ""))).toBe(false);
});

it("A04: readers cannot create merits or select a block in a planned season", async () => {
  const mock = installMockTransport("organizer", { delay: 0 }); restore = mock.restore;
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { role: "organizer", path: "/seasons/season-1/merits" });
  await settle(); await settle();
  expect(page.container.querySelector("form")).toBeNull();
  expect(mock.adapter.history.get.some((r) => r.url === "/merits")).toBe(false);
  await page.cleanup(); page = undefined; mock.restore();
  const leader = installMockTransport("leader", { delay: 0 }); restore = leader.restore;
  page = await mountWorkspace(<MeritEntryPage />, { role: "leader", path: `/merits?source_kind=block_volunteer&scope_id=${leader.state.blocks[0].block_id}` });
  await settle(); await settle();
  expect(page.container.querySelectorAll('a[href*="/merits"]').length).toBeGreaterThan(0);
  for (const season of leader.state.seasons.filter((x) => x.state === "closed" || x.state === "planned")) expect(page.container.querySelector(`a[href*="/seasons/${season.season_id}/merits"]`)).toBeNull();
});

it("A08: leadership excludes pending candidates, preserves valid candidates outside any block and handles 422", async () => {
  const f = createFixtures("chair");
  const adapter = new MockAdapter(api); restore = () => adapter.restore();
  adapter.onPut("/leadership/deputies").reply(422, { detail: { code: "unknown_user", message: "Unknown user 998", fields: { user_id: 998 } } });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["leadership"], { chair: f.user, deputies: [], revision: 1, capabilities: ["transfer_chair", "manage_chair_deputies"] });
  client.setQueryData(["contacts"], [{ ...f.profile, user_id: 998, blocks: "", in_profcom: true }, { ...f.profile, user_id: 999, in_profcom: false }]);
  page = await mountWorkspace(<LeadershipPage />, { client });
  const deputyPicker = page.container.querySelector<HTMLElement>('[data-entity-picker][data-field-name="users"]')!;
  const deputySearch = deputyPicker.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => { deputySearch.focus();deputySearch.click(); });
  const candidates = document.getElementById(deputySearch.getAttribute("aria-controls")!)!;
  expect(candidates.querySelector('[data-option-value="999"]')).toBeNull();
  expect(candidates.querySelector('[data-option-value="998"]')).not.toBeNull();
  expect(page.container.querySelector('input[value="999"]')).toBeNull();
  await pick(page.container, "users", "998");
  await submit(field(page.container, "users").closest("form")!);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Участник не найден.");
  expect(page.container.querySelector('[role="alert"]')?.textContent).not.toContain("Unknown user");
  expect(JSON.parse(adapter.history.put[0].data).user_ids).toEqual([998]);
  expect(deputyPicker.querySelector('[data-selected-value="998"]')).not.toBeNull();
  await change(field(page.container, "user"), "998");
  await act(async () => client.setQueryData(["contacts"], [{ ...f.profile, user_id: 998, in_profcom: false }]));
  await settle();
  await submit(field(page.container, "user").closest("form")!);
  expect(page.container.textContent).toContain("больше не доступен для назначения");
  expect(adapter.history.post).toHaveLength(0);
});

it("A02: the actual profile form awaits its mutation and shows structured field errors", async () => {
  const f = createFixtures("organizer");
  const adapter = new MockAdapter(api); restore = () => adapter.restore();
  adapter.onPatch(`/profile/${f.profile.user_id}`).reply(422, { detail: { code: "invalid_input", message: "Invalid phone", fields: { phone: "Неверный телефон" } } });
  page = await mountWorkspace(<HelmetProvider><UserContext.Provider value={f.profile}><ProfileEditPage /></UserContext.Provider></HelmetProvider>);
  for (const [name, value] of Object.entries({ patronymic: "Иванович", group_number: "201", tg: "", vk: "", email: "student@example.org", phone: "Мой ввод" })) await change(field(page.container, name), value);
  await submit(page.container.querySelector("form")!);
  expect(adapter.history.patch).toHaveLength(1);
  expect(page.container.textContent).toContain("Проверьте введённые данные.");
  expect(page.container.textContent).not.toContain("Invalid phone");
  expect(page.container.textContent).toContain("Неверный телефон");
  expect(field(page.container, "phone").value).toBe("Мой ввод");
});

it("A01/FE-04: an approved outsider sees block information without a tracker entry", async () => {
  const mock = installMockTransport("organizer", { delay: 0 }); restore = mock.restore;
  const block = mock.state.blocks[0];
  block.members = block.members.filter((m) => m.user.user_id !== mock.state.session.user_id);
  block.capabilities = block.capabilities.filter((cap) => cap !== "view_tasks");
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { role: "organizer", path: `/blocks/${block.block_id}` });
  await settle(); await settle();
  expect(page.container.textContent).toContain("Состав блока");
  expect(page.container.querySelector('a[href^="/tasks?scope_kind=block"]')).toBeNull();
});

it.each(["head_merit", "subevent_volunteer"] as const)("A04: %s belongs to its event's planned season", async (kind) => {
  const mock = installMockTransport("leader", { delay: 0 }); restore = mock.restore;
  const planned = mock.state.seasons.find((s) => s.state === "planned")!;
  mock.state.events[0].season_id = planned.season_id;
  const session = { ...mock.state.session, capabilities: mock.state.session.capabilities.filter((cap) => !["create_volunteer_merit", "view_summary"].includes(cap)) };
  const scopeId = kind === "head_merit" ? "event-1" : "subevent-1";
  page = await mountWorkspace(<SessionContext.Provider value={{ session, loading: false, error: null, refresh: () => {} }}><Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes></SessionContext.Provider>, { role: "leader", path: `/seasons/${planned.season_id}/merits?source_kind=${kind}&scope_id=${scopeId}` });
  await settle(); await settle();
  await fillMerit(page.container, mock.state.people[0].user_id!);
  expect(mock.state.merits[0]).toMatchObject({ source_kind: kind, season_id: planned.season_id });
  if (kind === "head_merit") expect(mock.state.merits[0].event_id).toBe(scopeId);
  else expect(mock.state.merits[0].scope).toEqual({ kind: "subevent", id: scopeId });
});

it("A04: material editorship does not grant merit creation", async () => {
  const mock = installMockTransport("editor", { delay: 0 }); restore = mock.restore;
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { role: "editor", path: "/seasons/season-1/merits" });
  await settle(); await settle();
  expect(page.container.querySelector("form")).toBeNull();
  expect(page.container.textContent).toContain("Нет доступа к исходным полям");
});
