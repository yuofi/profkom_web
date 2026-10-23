// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { seasonsApi } from "../../utils/api/seasons.api";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import { materialsApi } from "../../utils/api/materials.api";
import { richText, type Event, type Subevent } from "../../utils/api/contract";
import { EventPage, SubeventPage } from "./EventPages";
import { MaterialsPage } from "./MaterialPages";

// FIX_PLAN 3.4: the UI offers an action exactly when the server's policy allows it.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });
const chair = "chair@example.com";

async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");
  if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Access capabilities", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const result = await seasonsApi.command(planned.season_id, "open", {expected_revision: planned.revision});
  return "season" in result ? result.season : result;
}
async function linksOn(email: string, path: string) {
  const session = await liveLogin(email);
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>, {path, session});
  await waitForPage(page, () => !!page!.container.textContent?.includes("Отчёты"));
  const links = Array.from(page.container.querySelectorAll("a"), a => a.textContent?.trim());
  await page.cleanup(); page = undefined;
  return links;
}

it("ACC-3.4: the meeting link is shown only with view_meeting (A-EVT-4)", async () => {
  const head = await liveParticipant("acc-head"), resp = await liveParticipant("acc-resp");
  const organizer = await liveParticipant("acc-org"), outsider = await liveParticipant("acc-outsider");
  const season = await openSeason();
  let event = await eventsApi.create({season_id: season.season_id, title: "ACC meeting links", description: richText("")});
  event = await eventsApi.leaders("events", event.event_id, [head.user_id], {expected_revision: event.revision}) as Event;
  let sub = await eventsApi.createSubevent(event.event_id, {title: "ACC subevent", description: richText("")});
  sub = await eventsApi.leaders("subevents", sub.subevent_id, [resp.user_id], {expected_revision: sub.revision}) as Subevent;
  await eventsApi.organizers(sub.subevent_id, [organizer.user_id], {expected_revision: sub.revision});
  const leadersMeeting: [string, boolean][] = [[chair, true], [head.email, true], [resp.email, true], [organizer.email, false], [outsider.email, false]];
  for (const [email, shown] of leadersMeeting)
    expect((await linksOn(email, `/events/${event.event_id}`)).includes("Созвон руководителей"), email).toBe(shown);
  for (const email of [chair, head.email, resp.email, organizer.email])
    expect(await linksOn(email, `/subevents/${sub.subevent_id}`), email).toContain("Созвон");
});

it("ACC-3.4: material kinds follow create_shared_material and the blocks one leads (A-MAT-13)", async () => {
  const master = await liveParticipant("acc-master");
  await liveLogin();
  const block = (await membershipApi.blocks()).find(b => b.name === "Integration IT")!;
  await eventsApi.blockLeader(block.block_id, master.user_id, {expected_revision: block.revision});
  const open = async (email: string) => {
    const session = await liveLogin(email);
    page = await mountWorkspace(<Routes><Route path="/materials" element={<MaterialsPage />} /></Routes>, {path: "/materials", session});
    await waitForPage(page, () => !!page!.container.querySelector('select[name="kind"]'));
    const form = page.container.querySelector('select[name="kind"]')!.closest("form")!;
    const kinds = Array.from((field(form, "kind") as HTMLSelectElement).options, o => o.value).filter(Boolean);
    return {form, kinds};
  };
  expect((await open(master.email)).kinds).toEqual(["guide"]);
  await page!.cleanup(); page = undefined;
  const {form, kinds} = await open(chair);
  expect(kinds).toEqual(["kmb", "guide", "general"]);
  await change(field(form, "title"), "ACC КМБ");
  await change(field(form, "description"), "Создан председателем");
  await change(field(form, "kind"), "kmb");
  await submit(form);
  await waitForPage(page!);
  expect((await materialsApi.list()).items.some(m => m.kind === "kmb" && m.title === "ACC КМБ")).toBe(true);
});
