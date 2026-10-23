// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { emptyCriteria, richText, type MeritCreate } from "../../utils/api/contract";
import { moscowInput } from "../../utils/dates";
import { MeritsPage } from "./MeritPages";

// FIX_PLAN 1.2: an existing record is corrected through its form (A-KKR-1), and recording
// a work leaves an empty form behind, so it cannot be recorded twice (A-KKR-24).
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();

/** A fresh season in `state`: its event is led by `head`, the event's subevent by `resp`. */
async function world(state: "open" | "summarizing") {
  const master = await liveParticipant("merit-master"), resp = await liveParticipant("merit-resp");
  const head = await liveParticipant("merit-head"), volunteer = await liveParticipant("merit-volunteer");
  await liveLogin();
  // At most one season may be planned, so another test's planned season is taken over.
  let season = (await seasonsApi.list()).items.find(s => s.state === "planned") ?? await seasonsApi.create({title: `Заслуги: ${state}`,
    type: "autumn_winter", starts_at: hoursAgo(48), ends_at: new Date(Date.now() + 30 * 86400000).toISOString()});
  const advance = async (command: "open" | "begin-summary") => {
    const result = await seasonsApi.command(season.season_id, command, {expected_revision: season.revision});
    season = "season" in result ? result.season : result;
  };
  await advance("open");
  const block = (await membershipApi.blocks()).find(b => b.name === "Integration IT")!;
  await eventsApi.blockLeader(block.block_id, master.user_id, {expected_revision: block.revision});
  const event = await eventsApi.create({season_id: season.season_id, title: `Мероприятие заслуг: ${state}`, description: richText("")});
  await eventsApi.leaders("events", event.event_id, [head.user_id], {expected_revision: event.revision});
  const sub = await eventsApi.createSubevent(event.event_id, {title: `Подмероприятие заслуг: ${state}`, description: richText("")});
  await eventsApi.leaders("subevents", sub.subevent_id, [resp.user_id], {expected_revision: sub.revision});
  if (state === "summarizing") await advance("begin-summary");
  return {season, master, resp, head, volunteer, block, event, sub};
}
async function openMerits(email: string, seasonId: string) {
  const session = await liveLogin(email);
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, {path: `/seasons/${seasonId}/merits`, session});
}
const card = (title: string) => Array.from(page!.container.querySelectorAll("section"))
  .find(section => section.querySelector(":scope > h2")?.textContent === title);
const select = (root: ParentNode, label: string) => Array.from(root.querySelectorAll("label"))
  .find(l => l.textContent?.startsWith(label))?.querySelector("select");

for (const state of ["open", "summarizing"] as const)
  it(`1.2: each kind of record is corrected through its form in a ${state} season`, async () => {
    const w = await world(state);
    const records: [string, MeritCreate["source_kind"], Partial<MeritCreate>, string | null][] = [
      [w.master.email, "block_volunteer", {scope: {kind: "block", id: w.block.block_id}}, w.block.name],
      [w.resp.email, "subevent_volunteer", {scope: {kind: "subevent", id: w.sub.subevent_id}}, w.sub.title],
      [w.head.email, "head_merit", {event_id: w.event.event_id}, w.event.title],
      ["chair@example.com", "chair_merit", {}, null],
    ];
    for (const [email, source_kind, scope, scopeName] of records) {
      await liveLogin(email);
      const title = `Работа ${source_kind}: ${state}`;
      const merit = await seasonsApi.createMerit({season_id: w.season.season_id, source_kind, ...scope, title, description: richText("Сделано"),
        assigned_at: hoursAgo(3), deadline_at: hoursAgo(2), criteria: emptyCriteria(), reason: "Постфактум",
        recipients: [{user_id: w.volunteer.user_id, hours: 2, evaluation: 1, completed_at: hoursAgo(2)}]});
      await openMerits(email, w.season.season_id);
      const hours = `hours_${w.volunteer.user_id}`;
      await waitForPage(page!, () => !!card(title)?.querySelector(`[name="${hours}"]`));
      const form = card(title)!.querySelector(`[name="${hours}"]`)!.closest("form")!;
      const scopeSelect = select(card(title)!, "Область работы");
      if (scopeName === null) expect(scopeSelect, source_kind).toBeUndefined();
      else expect(scopeSelect?.selectedOptions[0]?.textContent, source_kind).toBe(scopeName);
      await change(field(form, hours), "5");
      await change(field(form, "reason"), "Исправили часы");
      await submit(form);
      await waitForPage(page!, () => !!form.textContent?.includes("Изменения сохранены") || !!form.querySelector('[role="alert"]'));
      expect(form.querySelector('[role="alert"]')?.textContent, source_kind).toBeUndefined();
      const saved = await seasonsApi.merit(merit.merit_id);
      expect([saved.revision, saved.recipients[0].hours, saved.source_kind], source_kind).toEqual([2, 5, source_kind]);
      await page!.cleanup(); page = undefined;
    }
  });

it("1.2: recording a work leaves an empty form, and a second click records nothing", async () => {
  const w = await world("open");
  await openMerits("chair@example.com", w.season.season_id);
  const newCard = () => card("Учесть выполненную работу")!;
  await waitForPage(page!, () => !!select(newCard() ?? document, "Область работы"));
  await change(select(newCard(), "Вид записи")!, "subevent_volunteer");
  await waitForPage(page!);
  await change(select(newCard(), "Область работы")!, w.sub.subevent_id);
  await waitForPage(page!, () => !!newCard().querySelector(`input[type="checkbox"][value="${w.volunteer.user_id}"]`));
  let form = newCard().querySelector("form")!;
  const title = "Помощь на регистрации";
  await change(field(form, "title"), title);
  await change(field(form, "body"), "Встречали гостей");
  await change(field(form, "assigned"), moscowInput(hoursAgo(3)));
  await change(field(form, "deadline"), moscowInput(hoursAgo(2)));
  await act(async () => form.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${w.volunteer.user_id}"]`)!.click());
  await change(field(form, `hours_${w.volunteer.user_id}`), "2");
  await change(field(form, `evaluation_${w.volunteer.user_id}`) as HTMLSelectElement, "1");
  await change(field(form, `completed_${w.volunteer.user_id}`), moscowInput(hoursAgo(2)));
  await change(field(form, "reason"), "Постфактум");
  await submit(form);
  await waitForPage(page!, () => !!newCard().textContent?.includes(`Работа записана: ${title}`) || !!newCard().querySelector('[role="alert"]'));
  expect(newCard().querySelector('[role="alert"]')?.textContent).toBeUndefined();
  // The form is a new one: the kind, scope, recipients and every field start over.
  form = newCard().querySelector("form")!;
  expect(select(newCard(), "Вид записи")!.value).toBe("block_volunteer");
  expect(select(newCard(), "Область работы")!.value).toBe("");
  expect((field(form, "title") as HTMLInputElement).value).toBe("");
  expect(form.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
  await submit(form);
  await waitForPage(page!);
  const records = (await seasonsApi.merits({season_id: w.season.season_id})).items.filter(m => m.title === title);
  expect(records).toHaveLength(1);
  const credited = (await seasonsApi.assessments({season_id: w.season.season_id})).items
    .filter(c => c.source_title === title && c.user.user_id === w.volunteer.user_id);
  expect(credited).toHaveLength(1);
});
