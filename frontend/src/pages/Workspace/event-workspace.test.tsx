// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { richText } from "../../utils/api/contract";
import { eventsApi } from "../../utils/api/events.api";
import { outsideParentPeriod } from "./eventDates";
import { occursOnDay, monthDays, validMonth } from "../../utils/calendar";
import { EventsListPage, EventPage, SubeventCreatePage, SubeventEditPage, SubeventPage } from "./EventPages";
import { CalendarPage, DashboardPage } from "./WorkspacePages";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page=undefined;mock?.restore();mock=undefined;vi.restoreAllMocks();vi.useRealTimers(); });

it("uses exact Moscow half-open intervals and an inclusive final all-day date", () => {
  expect(occursOnDay({ starts_at:"2026-10-30T18:00:00Z",ends_at:"2026-11-02T21:00:00Z" },"2026-11-02")).toBe(true);
  expect(occursOnDay({ starts_at:"2026-10-30T18:00:00Z",ends_at:"2026-11-02T21:00:00Z" },"2026-11-03")).toBe(false);
  expect(occursOnDay({ starts_at:"2026-10-31T21:00:00Z",ends_at:"2026-10-31T21:00:00Z",all_day:true },"2026-11-01")).toBe(true);
  expect(occursOnDay({ starts_at:"2026-10-31T21:00:00Z",ends_at:"2026-10-31T21:00:00Z",all_day:true },"2026-11-02")).toBe(false);
  expect(monthDays("2026-11").to).toBe("2026-11-30T21:00:00.000Z");expect(validMonth("2026-13")).toBe(false);
});
it("puts heads in the event's team card, not the header, and removes the annual-copy action (D-04)", async () => {
  mock=installMockTransport("chair",{delay:0});const event=mock.state.events[0];
  page=await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage/>}/></Routes>,{path:`/events/${event.event_id}`});await waitForPage(page);
  const header=page.container.querySelector("header")!;expect(header.textContent).not.toContain("Главорги");expect(header.querySelector('a[href^="/contacts/"]')).toBeNull();
  const team=[...page.container.querySelectorAll("section")].find(section=>section.querySelector(":scope > h2")?.textContent==="Команда")!;
  expect(team.querySelector("h3")?.textContent).toBe("Главорги");expect(team.querySelector('a[href^="/contacts/"]')).not.toBeNull();
  expect(page.container.textContent).not.toContain("Создать новый ежегодный экземпляр");expect(page.container.querySelector('[name="title"]')).toBeNull();
  // GL-36: the way back to the list is the section stamp alone, not a second «Все мероприятия».
  expect([...header.querySelectorAll('a[href="/events"]')].map(link => link.textContent)).toEqual(["Профком ВМК · Мероприятия"]);
  expect(header.textContent).not.toContain("Все мероприятия");
  expect(header.querySelector('[role="group"][aria-label="Действия мероприятия"]')?.textContent).toContain("Изменить мероприятие");
});
it("GL-36: a reader without event actions gets no empty action group in the header", async () => {
  mock=installMockTransport("chair",{delay:0});const event=mock.state.events[0];event.capabilities=event.capabilities.filter(name=>!["edit_event","close_event","reopen_event"].includes(name));
  page=await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage/>}/></Routes>,{path:`/events/${event.event_id}`});await waitForPage(page);
  const header=page.container.querySelector("header")!;expect(header.querySelector('a[href="/events"]')?.textContent).toBe("Профком ВМК · Мероприятия");
  expect(header.querySelector('[role="group"][aria-label="Действия мероприятия"]')).toBeNull();
});
it("presents children as labeled independent entries with real dates and preserved navigation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0], child = mock.state.subevents[0];
  child.starts_at = "2026-10-28T10:00:00Z";child.ends_at = "2026-10-29T12:00:00Z";child.announcement = richText("Анонс участникам");child.description = richText("PRIVATE WORKING CONTENT");
  mock.state.subevents.push({ ...structuredClone(child), subevent_id: "child-undated", title: "Программа уточняется", starts_at: null, ends_at: null, announcement: richText("") });
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /><Route path="/subevents/:id" element={<h1>Открыто подмероприятие</h1>} /></Routes>, { path: `/events/${event.event_id}` });await waitForPage(page);
  const list = page.container.querySelector('ul[aria-label="Все подмероприятия"]')!;
  const rows = [...list.children];expect(rows).toHaveLength(2);
  for (const row of rows) { expect(row.querySelector("h3 a")).not.toBeNull();expect(row.querySelector("small")).not.toBeNull();expect(row.textContent).toContain("Подмероприятие"); }
  expect(rows[0].querySelector("small")?.textContent).toMatch(/28\s+окт\./);expect(rows[1].textContent).toContain("Даты уточняются");
  expect(list.textContent).toContain("Анонс участникам");expect(page.container.textContent).not.toContain("PRIVATE WORKING CONTENT");
  const nearest = page.container.querySelector('ul[aria-label="Ближайшие подмероприятия"]')!;expect(nearest.children).toHaveLength(1);expect(nearest.textContent).toContain("Подмероприятие");
  await act(async () => list.querySelector<HTMLAnchorElement>(`a[href="/subevents/${child.subevent_id}"]`)!.click());expect(page.container.querySelector("h1")?.textContent).toBe("Открыто подмероприятие");
});
it("renders a safe public child announcement and compact roster without private work controls", async () => {
  mock=installMockTransport("organizer",{delay:0});const sub=mock.state.subevents[0];sub.organizer_user_ids=[];sub.leaders=[];sub.announcement=richText("Открытый анонс");sub.description=richText("СЕКРЕТ РАБОТЫ");
  page=await mountWorkspace(<Routes><Route path="/subevents/:id" element={<SubeventPage/>}/></Routes>,{path:`/subevents/${sub.subevent_id}`,role:"organizer"});await waitForPage(page);
  expect(page.container.textContent).toContain("Открытый анонс");expect(page.container.textContent).not.toContain("СЕКРЕТ РАБОТЫ");expect(page.container.textContent).not.toContain("Задачи команды");expect(page.container.textContent).not.toContain("Рабочая информация");
  expect(mock.adapter.history.get.some(request=>request.url?.includes("/reports"))).toBe(false);
  expect(mock.adapter.history.get.some(request=>request.url?.includes("/history"))).toBe(false);
  const listing = await eventsApi.subevents(sub.event_id);
  expect(listing.items.find(item => item.subevent_id === sub.subevent_id)).toMatchObject({ announcement: richText("Открытый анонс"), description: richText(""), report_series_id: null, capabilities: [], working_access: false });
});
it("offers the team task list to a task reader without the working subevent ACL", async () => {
  mock=installMockTransport("organizer",{delay:0});const sub=mock.state.subevents[0];sub.announcement=richText("Открытый анонс");
  vi.spyOn(eventsApi,"subevent").mockResolvedValue({...structuredClone(sub),description:richText(""),report_series_id:null,working_access:false,capabilities:["view_tasks"]});
  page=await mountWorkspace(<Routes><Route path="/subevents/:id" element={<SubeventPage/>}/></Routes>,{path:`/subevents/${sub.subevent_id}`,role:"organizer"});await waitForPage(page);
  expect([...page.container.querySelectorAll("a")].find(link => link.textContent === "Задачи команды")?.getAttribute("href")).toBe(`/tasks?scope_kind=subevent&scope_id=${encodeURIComponent(sub.subevent_id)}`);
  expect(page.container.textContent).not.toContain("Рабочая информация");
});
it("creates a child using explicit public/work text and real all-day date fields", async () => {
  mock=installMockTransport("chair",{delay:0});const parent=mock.state.events[0];
  page=await mountWorkspace(<Routes><Route path="/events/:id/subevents/new" element={<SubeventCreatePage/>}/><Route path="/subevents/:id" element={<p>Страница подмероприятия</p>}/></Routes>,{path:`/events/${parent.event_id}/subevents/new`});await waitForPage(page,()=>!!page!.container.querySelector('[name="title"]'));
  await change(field(page.container,"title"),"Новый анонс");await change(field(page.container,"announcement"),"Для всех");await change(field(page.container,"description"),"Для команды");
  await act(async()=>page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await change(field(page.container,"starts"),"2026-10-28");await change(field(page.container,"ends"),"2026-10-29");await submit(page.container.querySelector("form")!);await waitForPage(page);
  const request=mock.adapter.history.post.find(request=>request.url?.endsWith("/subevents"))!;const body=JSON.parse(request.data);
  expect(body).toMatchObject({announcement:richText("Для всех"),description:richText("Для команды"),all_day:true,starts_at:"2026-10-27T21:00:00.000Z",ends_at:"2026-10-28T21:00:00.000Z"});expect(page.container.textContent).toContain("Страница подмероприятия");
});
it("opens the subevent editors at their own addresses and keeps the access checks there (EV-07)", async () => {
  mock=installMockTransport("chair",{delay:0});const parent=mock.state.events[0];const sub=mock.state.subevents.find(item=>item.event_id===parent.event_id)!;
  const routes=<Routes><Route path="/events/:id" element={<EventPage/>}/><Route path="/events/:id/subevents/new" element={<SubeventCreatePage/>}/><Route path="/subevents/:id" element={<SubeventPage/>}/><Route path="/subevents/:id/edit" element={<SubeventEditPage/>}/></Routes>;
  page=await mountWorkspace(routes,{path:`/events/${parent.event_id}`});await waitForPage(page);
  expect([...page.container.querySelectorAll("a")].find(link=>link.textContent==="Добавить подмероприятие")?.getAttribute("href")).toBe(`/events/${parent.event_id}/subevents/new`);
  await page.cleanup();
  page=await mountWorkspace(routes,{path:`/subevents/${sub.subevent_id}`});await waitForPage(page);
  const edit=[...page.container.querySelectorAll("a")].find(link=>link.textContent==="Редактировать подмероприятие")!;
  expect(edit.getAttribute("href")).toBe(`/subevents/${sub.subevent_id}/edit`);
  await act(async()=>edit.click());await waitForPage(page,()=>!!page!.container.querySelector('[name="title"]'));
  expect(field(page.container,"title").value).toBe(sub.title);
  expect([...page.container.querySelectorAll("a")].find(link=>link.textContent==="Отмена")?.getAttribute("href")).toBe(`/subevents/${sub.subevent_id}`);
  await page.cleanup();mock.restore();
  // A direct address does not bypass the subevent's own capabilities.
  mock=installMockTransport("organizer",{delay:0});const foreign=mock.state.subevents.find(item=>!item.capabilities?.includes("edit_subevent"))??mock.state.subevents[0];
  page=await mountWorkspace(routes,{path:`/subevents/${foreign.subevent_id}/edit`,role:"organizer"});await waitForPage(page);
  expect(page.container.querySelector('[name="title"]')).toBeNull();expect(page.container.textContent).toContain("Изменение подмероприятия вам недоступно.");
  await page.cleanup();
  page=await mountWorkspace(routes,{path:`/events/${foreign.event_id}/subevents/new`,role:"organizer"});await waitForPage(page);
  expect(page.container.querySelector('[name="title"]')).toBeNull();expect(page.container.textContent).toContain("Добавление подмероприятия вам недоступно.");
});
it("shows current and nearest event overview with mine and archive choices", async () => {
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));mock=installMockTransport("organizer",{delay:0});
  mock.state.events[0].starts_at="2026-10-26T12:00:00Z";mock.state.events[0].ends_at="2026-10-28T12:00:00Z";
  page=await mountWorkspace(<EventsListPage/>,{role:"organizer"});await waitForPage(page);
  expect(page.container.querySelector('h2[aria-label="Сейчас идут"]')).not.toBeNull();expect(page.container.textContent).toContain("С моим участием");expect(page.container.textContent).toContain("Архив");
  expect(mock.adapter.history.post).toHaveLength(0);
});
it("calendar keeps URL filters and repeats a multi-day announcement on each covered day", async () => {
  mock=installMockTransport("chair",{delay:0});const event=mock.state.events[0];event.starts_at="2026-10-30T12:00:00Z";event.ends_at="2026-11-02T12:00:00Z";
  page=await mountWorkspace(<CalendarPage/>,{path:"/calendar?month=2026-11&mine=false&kind=event"});await waitForPage(page);
  expect(page.container.querySelector('[aria-label="2026-11-01"]')?.textContent).toContain(event.title);expect(page.container.querySelector('[aria-label="2026-11-02"]')?.textContent).toContain(event.title);expect(page.container.querySelector('[aria-label="2026-11-03"]')?.textContent).not.toContain(event.title);
  expect(page.container.querySelector('[aria-label="Убрать фильтр: Вид записи"]')).not.toBeNull();const request=mock.adapter.history.get.filter(request=>request.url?.includes("/calendar")).at(-1)!;expect(request.params).toMatchObject({mine:false,kind:"event"});
});
it("home shows real sections and keeps already implemented personal teams", async () => {
  mock=installMockTransport("chair",{delay:0});page=await mountWorkspace(<DashboardPage/>);await waitForPage(page);
  expect(page.container.textContent).toContain("Ближайшие задачи");expect(page.container.textContent).toContain("Мои команды");expect(page.container.textContent).toContain("Мои блоки");
  // D-01: the watched-tasks box moved from its own row above the cards into the card of the nearest tasks.
  expect(page.container.querySelector('[aria-label="Задачи по срокам"] [class*="taskMeta"] input[type="checkbox"]')?.parentElement?.textContent).toBe("Также задачи, за которыми я наблюдаю");
  const calls=mock.adapter.history.get.filter(request=>request.url?.includes("/workspace/home"));expect(calls).toHaveLength(1);expect(calls[0].params).toMatchObject({watching:false});
});

it("warns on known partial child dates and includes an all-day parent's final date", () => {
  const parent = { starts_at: "2026-10-28T00:00:00+03:00", ends_at: "2026-10-28T00:00:00+03:00", all_day: true };
  expect(outsideParentPeriod({ starts_at: "2026-10-28T18:00:00+03:00", ends_at: "2026-10-28T20:00:00+03:00" }, parent)).toBe(false);
  expect(outsideParentPeriod({ starts_at: "2026-10-29T00:00:00+03:00" }, parent)).toBe(true);
  expect(outsideParentPeriod({ ends_at: "2026-10-27T00:00:00+03:00", all_day: true }, parent)).toBe(true);
  expect(outsideParentPeriod({}, parent)).toBe(false);
});
