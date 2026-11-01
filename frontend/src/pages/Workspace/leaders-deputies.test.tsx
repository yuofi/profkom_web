// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { EventPage, SubeventPage } from "./EventPages";
import { BlockPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });
const count = (text: string, part: string) => text.split(part).length - 1;

const card = (title: string) => [...page!.container.querySelectorAll("section")].find(section => section.querySelector(":scope > h2, :scope > div > h2")?.textContent === title)!;
const routes = <Routes><Route path="/events/:id" element={<EventPage />} /><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>;

it("each leader is one row of the team card with that leader's deputies and their pencil (EV-11, D-04)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0], leader = event.leaders[0];
  // A second head without deputies: each row names only its own deputies.
  event.leaders.push({ ...structuredClone(leader), role_assignment_id: "leader-2", user: mock.state.people[2], deputy_user_ids: [] });
  const save = vi.spyOn(eventsApi, "deputies").mockResolvedValue({ ...leader, deputy_user_ids: [105, 104], revision: leader.revision + 1 });
  page = await mountWorkspace(routes, { path: `/events/${event.event_id}` });await waitForPage(page);
  expect(page.container.querySelector("header")!.textContent).not.toContain("Заместители");
  const rows = [...card("Команда").querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows.map(row => count(row.textContent!, "Заместители"))).toEqual([1, 1]);
  expect(rows[0].querySelector('a[href="/contacts/105"]')).not.toBeNull();
  expect(rows[1].textContent).toContain("не назначены");expect(rows[1].querySelector('a[href="/contacts/105"]')).toBeNull();
  expect(card("Команда").querySelector("details, form")).toBeNull();
  const pencil = rows[0].querySelector<HTMLButtonElement>(`button[aria-label="Изменить заместителей: ${leader.user.display_name}"]`)!;
  // The pencil ends the leader's row, beside (not inside) the deputies' line.
  expect(pencil.parentElement).toBe(rows[0]);
  await act(async () => pencil.click());
  await waitForPage(page, () => !!document.querySelector("dialog form"));
  // The dialog leaves the row and the card, so their button styles do not apply to it.
  expect(document.querySelector("dialog")!.closest("li, section, header")).toBeNull();
  const form = document.querySelector<HTMLFormElement>("dialog form")!;
  expect(document.querySelector("dialog")?.textContent).toContain(`Руководитель: ${leader.user.display_name}`);
  await pick(form, "users", "104");await submit(form);
  await waitForPage(page, () => !document.querySelector("dialog"));
  expect(save).toHaveBeenCalledWith(leader.role_assignment_id, [105, 104], { expected_revision: leader.revision });
});

it("a subevent's header keeps crumbs, title, dates and actions; its team card reads leaders, organizers, HR (D-04)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const sub = mock.state.subevents[0];sub.capabilities.push("assign_subevent_hr");
  page = await mountWorkspace(routes, { path: `/subevents/${sub.subevent_id}` });await waitForPage(page);
  const header = page.container.querySelector("header")!;
  expect(header.querySelector('a[href^="/contacts/"], button')).toBeNull();
  expect(header.textContent).not.toContain("Ответственные");
  const team = card("Команда");
  expect([...team.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual(["Ответственные", "Организаторы", "HR подмероприятия"]);
  // Each part's pencil stands at the right of its own heading.
  for (const [heading, label] of [["Ответственные", "Изменить ответственных"], ["Организаторы", "Изменить состав организаторов"], ["HR подмероприятия", "Изменить HR подмероприятия"]]) {
    const pencil = team.querySelector(`button[aria-label="${label}"]`)!;
    expect(pencil.parentElement!.querySelector("h3")?.textContent).toBe(heading);
  }
  expect(team.querySelector(`li button[aria-label^="Изменить заместителей"]`)).not.toBeNull();
  await act(async () => team.querySelector<HTMLButtonElement>('button[aria-label="Изменить ответственных"]')!.click());
  await waitForPage(page, () => !!page!.container.querySelector("dialog"));
  expect(page.container.querySelector("dialog")?.textContent).toContain("Ответственные");
});

it("a reader without rights sees each leader's deputies in that leader's row and no pencils (D-04)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const sub = mock.state.subevents[0];
  sub.leaders = [{ ...structuredClone(sub.leaders[0]), capabilities: [] }, { ...structuredClone(sub.leaders[0]), role_assignment_id: "subevent-leader-2", user: mock.state.people[2], deputy_user_ids: [104], capabilities: [] }];
  sub.capabilities = sub.capabilities.filter(name => !["manage_leaders", "manage_organizers", "assign_subevent_hr"].includes(name));
  page = await mountWorkspace(routes, { path: `/subevents/${sub.subevent_id}`, role: "organizer" });await waitForPage(page);
  const rows = [...card("Команда").querySelectorAll("li")];
  expect(rows.map(row => [...row.querySelectorAll('a[href^="/contacts/"], a[href="/profile"]')].map(link => link.getAttribute("href")))).toEqual([
    ["/contacts/102", "/contacts/105"], ["/contacts/103", "/contacts/104"],
  ]);
  expect(card("Команда").querySelector("button")).toBeNull();
});

it("the block's master and deputies are changed in one leadership dialog with separate sections (EV-11)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const block = mock.state.blocks[0];
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${block.block_id}` });await waitForPage(page);
  const leadership = [...page.container.querySelectorAll("h2")].find(heading => heading.textContent === "Руководство")!.closest("section")!;
  expect(leadership.querySelector("form, details")).toBeNull();
  expect(leadership.querySelector('button[aria-label^="Изменить заместителей"]')).toBeNull();
  expect(count(leadership.textContent!, "Заместители")).toBe(1);
  await act(async () => [...leadership.querySelectorAll("button")].find(button => button.textContent === "Изменить руководство")!.click());
  await waitForPage(page, () => !!page!.container.querySelector("dialog"));
  const dialog = page.container.querySelector("dialog")!;
  expect(dialog.querySelectorAll("form")).toHaveLength(2);
  expect(dialog.querySelector('[aria-label="Мастер блока"] [data-field-name="user"]')).not.toBeNull();
  expect(dialog.querySelector('[aria-label="Заместители мастера"] [data-field-name="users"]')).not.toBeNull();
});
