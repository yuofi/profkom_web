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
import { mountWorkspace, settle, change, field, submit } from "../../test/workspace";
import { AdminPanel } from "../Admin/AdminPage";
import { ExtendedRoute } from "../Wrappers/wrappers";
import { BlocksPage, RegistrationsPage } from "./MembershipPages";
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
      <Route element={<ExtendedRoute />}><Route path="/admin/:tab" element={<AdminPanel />} /></Route>
      <Route path="/registrations" element={<RegistrationsPage />} />
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
        data: { detail: { code: "invalid_input", message: "Проверьте сведения", fields: { title: "Уточните название" } } },
      }); },
    });
    return <form onSubmit={formik.handleSubmit}><input {...formik.getFieldProps("title")} />
      <p role="alert">{globalError}</p><span>{formik.errors.title}</span><button type="submit">Отправить</button></form>;
  }
  page = await mountWorkspace(<Probe />);
  await change(field(page.container, "title"), "Мой черновик");
  await submit(page.container.querySelector("form")!);
  expect(page.container.textContent).toContain("Проверьте сведения");
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
  expect(page.container.textContent).toContain("Проверьте заполнение полей");
  expect(page.container.textContent).toContain("Нужно название");
  expect(page.container.textContent).not.toContain("Request failed");
});

async function fillMerit(container: HTMLElement, userId: number) {
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
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
  expect(page.container.querySelectorAll("select")[1].value).toBe(block.block_id);
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
  expect(page.container.querySelectorAll("select")[1].value).toBe("event-1");
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
  adapter.onPut("/leadership/deputies").reply(422, { detail: { code: "invalid_input", message: "Нельзя назначить этого участника" } });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["leadership"], { chair: f.user, deputies: [], revision: 1, capabilities: ["transfer_chair", "manage_chair_deputies"] });
  client.setQueryData(["contacts"], [{ ...f.profile, user_id: 998, blocks: "", in_profcom: true }, { ...f.profile, user_id: 999, in_profcom: false }]);
  page = await mountWorkspace(<LeadershipPage />, { client });
  expect(page.container.querySelector('option[value="999"]')).toBeNull();
  expect(page.container.querySelector('option[value="998"]')).not.toBeNull();
  await change(field(page.container, "users"), "998");
  await submit(field(page.container, "users").closest("form")!);
  expect(page.container.textContent).toContain("Нельзя назначить этого участника");
  expect(JSON.parse(adapter.history.put[0].data).user_ids).toEqual([998]);
  expect(field(page.container, "users").value).toBe("998");
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
  adapter.onPatch(`/profile/${f.profile.user_id}`).reply(422, { detail: { code: "invalid_input", message: "Уточните контакты", fields: { phone: "Неверный телефон" } } });
  page = await mountWorkspace(<HelmetProvider><UserContext.Provider value={f.profile}><ProfileEditPage /></UserContext.Provider></HelmetProvider>);
  for (const [name, value] of Object.entries({ patronymic: "Иванович", group_number: "201", tg: "", vk: "", email: "student@example.org", phone: "Мой ввод" })) await change(field(page.container, name), value);
  await submit(page.container.querySelector("form")!);
  expect(adapter.history.patch).toHaveLength(1);
  expect(page.container.textContent).toContain("Уточните контакты");
  expect(page.container.textContent).toContain("Неверный телефон");
  expect(field(page.container, "phone").value).toBe("Мой ввод");
});
