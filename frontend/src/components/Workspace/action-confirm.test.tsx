// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { installMockTransport } from "../../mocks/transport";
import { eventsApi } from "../../utils/api/events.api";
import { ApiError } from "../../utils/api/request";
import { MeetingPage } from "../../pages/Workspace/ReportPages";
import { ActionForm } from "./ActionForm";
import type { EntityOption } from "./EntityPicker";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });
const people: EntityOption[] = [
  { value: "11", label: "Анна Иванова", user: { user_id: 11, display_name: "Анна Иванова", avatar_url: null } },
  { value: "12", label: "Мария Соколова", user: { user_id: 12, display_name: "Мария Соколова", avatar_url: null } },
];
const buttons = () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")];
const button = (text: string) => buttons().find(item => item.textContent === text);
async function click(text: string) { await act(async () => button(text)!.click()); await waitForPage(page!); }

it("an irreversible command asks once more with its target, can be withdrawn and runs only after the explicit answer (EV-05)", async () => {
  let revision = 4;
  const save = vi.fn(async (_values: unknown, expected?: number) => ({ revision: (revision = expected! + 1) }));
  page = await mountWorkspace(<ActionForm revision={revision} onConflict={() => {}} submitLabel="Передать пост" fields={[{ name: "user", label: "Новый председатель", type: "select", entity: "person", options: people, required: true }]}
    confirm={{ label: "Да, передать пост", text: values => `Передать пост председателя: ${people.find(person => person.value === values.user)?.label}?` }} onSubmit={save} />);
  const form = page.container.querySelector("form")!;
  await pick(form, "user", "11");
  await submit(form);
  expect(save).not.toHaveBeenCalled();
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Передать пост председателя: Анна Иванова?");
  expect(button("Передать пост")!.disabled).toBe(true);
  // Cancelling withdraws the question; another choice withdraws it too and names the new target.
  await click("Отмена");
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
  expect(button("Передать пост")!.disabled).toBe(false);
  await submit(form);
  await pick(form, "user", "12");
  expect(page.container.textContent).not.toContain("Передать пост председателя");
  await submit(form);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Передать пост председателя: Мария Соколова?");
  await click("Да, передать пост");
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({ user: "12" }, 4);
  expect(page.container.textContent).not.toContain("Передать пост председателя");
});

it("a refused confirmed command asks again before the next attempt", async () => {
  const save = vi.fn(async () => { throw new ApiError("Сервер отказал", 409, "season_not_ready"); });
  page = await mountWorkspace(<ActionForm fields={[]} submitLabel="Закрыть сезон" confirm={{ label: "Да, закрыть сезон", text: "Закрыть сезон «Осень»?" }} onSubmit={save} />);
  const form = page.container.querySelector("form")!;
  await submit(form);await click("Да, закрыть сезон");
  expect(save).toHaveBeenCalledTimes(1);
  await submit(form);
  expect(save).toHaveBeenCalledTimes(1);
  expect(page.container.textContent).toContain("Закрыть сезон «Осень»?");
});

it("removing a meeting announcement is confirmed with its title and carries the seen revision", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const sub = mock.state.subevents[0];
  const seen = await eventsApi.saveMeeting("subevents", sub.subevent_id, { title: "Созвон лекций", starts_at: "2026-11-02T15:00:00Z", join_url: "https://telemost.yandex.ru/j/1", ...(mock.state.meetings.find(item => item.owner_id === sub.subevent_id) ? { expected_revision: mock.state.meetings.find(item => item.owner_id === sub.subevent_id)!.revision } : {}) });
  const remove = vi.spyOn(eventsApi, "deleteMeeting");
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, { role: "chair", path: `/meetings/subevent/${sub.subevent_id}` });
  await waitForPage(page, () => !!button("Снять объявление"));
  await submit(button("Снять объявление")!.closest("form")!);
  expect(remove).not.toHaveBeenCalled();
  expect(page.container.textContent).toContain("Снять объявление «Созвон лекций»?");
  await click("Да, снять");
  await waitForPage(page, () => page!.container.textContent!.includes("Созвон пока не назначен."));
  expect(remove).toHaveBeenCalledWith("subevents", sub.subevent_id, { expected_revision: seen.revision });
  expect(mock.state.meetings.some(item => item.owner_id === sub.subevent_id)).toBe(false);
});
