// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { richText, type Subevent } from "../../utils/api/contract";
import { moscowInput } from "../../utils/dates";
import { can } from "../../utils/session";
import { MeetingPage } from "./ReportPages";

// FIX_PLAN 1.3: without an announcement the meeting page offers the form to those who may
// announce it (A-EVT-1), and the form follows the same rights as PUT and DELETE (A-SEC-5).
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });

async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");
  if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Meetings", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const result = await seasonsApi.command(planned.season_id, "open", {expected_revision: planned.revision});
  return "season" in result ? result.season : result;
}
/** An event led by `head` with a subevent led by `resp` and organized by `org`. */
async function team() {
  const head = await liveParticipant("meeting-head"), resp = await liveParticipant("meeting-resp");
  const org = await liveParticipant("meeting-org"), outsider = await liveParticipant("meeting-outsider");
  const season = await openSeason();
  const event = await eventsApi.create({season_id: season.season_id, title: "Созвоны", description: richText("")});
  await eventsApi.leaders("events", event.event_id, [head.user_id], {expected_revision: event.revision});
  let sub = await eventsApi.createSubevent(event.event_id, {title: "Созвоны подмероприятия", description: richText("")});
  sub = await eventsApi.leaders("subevents", sub.subevent_id, [resp.user_id], {expected_revision: sub.revision}) as Subevent;
  await eventsApi.organizers(sub.subevent_id, [org.user_id], {expected_revision: sub.revision});
  return {head, resp, org, outsider, event, sub};
}
async function openMeeting(email: string, kind: "event" | "subevent", id: string) {
  const session = await liveLogin(email);
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, {path: `/meetings/${kind}/${id}`, session});
  // Loading the owner enables the announcement request. An idle poll between those
  // two requests is not a ready page: wait for every dependent query and its DOM.
  await waitForPage(page, () => {
    const ownerKey = ["events", "meeting-owner", kind, id];
    const owner = page!.client.getQueryState(ownerKey);
    const data = page!.client.getQueryData<{ capabilities: string[] }>(ownerKey);
    const settled = (key: string[]) => {
      const state = page!.client.getQueryState(key);
      return state?.status === "success" || state?.status === "error";
    };
    if (owner?.status === "error") return !text().includes("Загружаем данные…");
    if (!data || owner?.status !== "success") return false;
    if (can(data, "view_meeting") && !settled(["events", "meeting", kind, id])) return false;
    if (kind === "event" && !settled(["events", "meeting-teams", id])) return false;
    return !text().includes("Загружаем данные…");
  });
}
const text = () => page!.container.textContent ?? "";
const announceForm = () => Array.from(page!.container.querySelectorAll("section"))
  .find(section => section.querySelector(":scope > h2")?.textContent === "Объявление созвона")?.querySelector("form");
const removeButton = () => Array.from(page!.container.querySelectorAll("button")).find(b => b.textContent === "Снять объявление");
const alert = () => page!.container.querySelector('[role="alert"]')?.textContent;
async function announce(title: string) {
  const form = announceForm()!;
  await change(field(form, "title"), title);
  await change(field(form, "starts"), moscowInput(new Date(Date.now() + 86400000).toISOString()));
  await change(field(form, "url"), "https://telemost.yandex.ru/j/1");
  await submit(form);
  await waitForPage(page!, () => text().includes("Подключиться") || !!alert());
  expect(alert()).toBeUndefined();
}

it("1.3: a lead announces a meeting, removes it and announces it again", async () => {
  const t = await team();
  for (const [kind, id, email] of [["subevent", t.sub.subevent_id, t.resp.email], ["event", t.event.event_id, t.head.email]] as const) {
    await openMeeting(email, kind, id);
    expect(text(), kind).toContain("Созвон пока не назначен.");
    await announce(`Первый созвон: ${kind}`);
    expect((await eventsApi.meeting(`${kind}s`, id))?.title, kind).toBe(`Первый созвон: ${kind}`);
    await submit(removeButton()!.closest("form")!);
    await waitForPage(page!, () => text().includes("Созвон пока не назначен.") || !!alert());
    expect(alert(), kind).toBeUndefined();
    expect(await eventsApi.meeting(`${kind}s`, id), kind).toBeNull();
    await announce(`Новый созвон: ${kind}`);
    expect((await eventsApi.meeting(`${kind}s`, id))?.title, kind).toBe(`Новый созвон: ${kind}`);
    await page!.cleanup(); page = undefined;
  }
});

it("1.3: the announcement form and its removal follow the meeting rights", async () => {
  const t = await team();
  // Decision of the owner (A-EVT-11 dropped): head organizers also edit subevent meetings.
  const views: [string, "event" | "subevent", string, boolean][] = [
    [t.org.email, "subevent", t.sub.subevent_id, false],
    [t.outsider.email, "subevent", t.sub.subevent_id, false],
    [t.resp.email, "event", t.event.event_id, false],
    [t.head.email, "subevent", t.sub.subevent_id, true],
  ];
  for (const announced of [false, true]) {
    if (announced) {
      await liveLogin();
      for (const kind of ["events", "subevents"] as const)
        await eventsApi.saveMeeting(kind, kind === "events" ? t.event.event_id : t.sub.subevent_id,
          {title: "Созвон", starts_at: new Date(Date.now() + 86400000).toISOString(), join_url: "https://telemost.yandex.ru/j/2"});
    }
    for (const [email, kind, id, editor] of views) {
      await openMeeting(email, kind, id);
      const who = `${email} on ${kind}, announced: ${announced}`;
      expect(!!announceForm(), who).toBe(editor);
      expect(!!removeButton(), who).toBe(editor && announced);
      await page!.cleanup(); page = undefined;
    }
  }
});

it("an event lists the organizer's team meeting without exposing its main or other team meetings", async () => {
  const t = await team();
  await liveLogin();
  const hiddenTeam = await eventsApi.createSubevent(t.event.event_id, { title: "Закрытая команда", description: richText() });
  const start = new Date(Date.now() + 86400000).toISOString();
  await eventsApi.saveMeeting("events", t.event.event_id, { title: "Закрытый главный созвон", starts_at: start, join_url: "https://example.invalid/main" });
  await eventsApi.saveMeeting("subevents", t.sub.subevent_id, { title: "Открытый созвон моей команды", starts_at: start, join_url: "https://example.invalid/team" });
  await eventsApi.saveMeeting("subevents", hiddenTeam.subevent_id, { title: "Чужой скрытый созвон", starts_at: start, join_url: "https://example.invalid/hidden" });
  await openMeeting(t.org.email, "event", t.event.event_id);
  expect(text()).toContain("Созвоны мероприятия");
  expect(text()).toContain("Открытый созвон моей команды");
  expect(text()).toContain("Главный созвон доступен только его участникам");
  expect(text()).not.toContain("Закрытый главный созвон");
  expect(text()).not.toContain("Чужой скрытый созвон");
  expect(page!.container.querySelector(`a[href="/meetings/subevent/${t.sub.subevent_id}"]`)).not.toBeNull();
  expect(alert()).toBeUndefined();
  await expect(eventsApi.meeting("events", t.event.event_id)).rejects.toMatchObject({ status: 404 });
  await expect(eventsApi.meeting("subevents", hiddenTeam.subevent_id)).rejects.toMatchObject({ status: 404 });
});


it("meeting rights remain visible after delayed dependent-query observer commits", async () => {
  const t = await team();
  await liveLogin();
  const announcement = { title: "Созвон с отложенным открытием", starts_at: new Date(Date.now() + 86400000).toISOString(), join_url: "https://example.invalid/delayed-meeting" };
  await eventsApi.saveMeeting("subevents", t.sub.subevent_id, announcement);
  // Cache requests may already be idle while React Query has not notified the owner
  // observer yet. Force that gap instead of relying on machine/load timing.
  notifyManager.setScheduler((callback) => setTimeout(callback, 80));
  try {
    await openMeeting(t.head.email, "subevent", t.sub.subevent_id);
    expect(announceForm()).toBeDefined();
    expect(removeButton()).toBeDefined();
    expect(field(announceForm()!, "title").value).toBe(announcement.title);
    expect(field(announceForm()!, "url").value).toBe(announcement.join_url);
  } finally {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  }
});
