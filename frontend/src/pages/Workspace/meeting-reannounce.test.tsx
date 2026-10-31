// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { moscowInput } from "../../utils/dates";
import { MeetingPage } from "./ReportPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; });
const text = () => page!.container.textContent ?? "";
const alert = () => page!.container.querySelector('[role="alert"]')?.textContent;
const button = (label: string) => [...page!.container.querySelectorAll("button")].find(item => item.textContent === label);
const announceForm = () => [...page!.container.querySelectorAll("section")].find(section => section.querySelector(":scope > h2")?.textContent === "Объявление созвона")!.querySelector("form")!;
async function announce(title: string) {
  const form = announceForm();
  await change(field(form, "title"), title);
  if (!field(form, "starts").value) await change(field(form, "starts"), moscowInput(new Date(Date.now() + 86400000).toISOString()));
  if (!field(form, "url").value) await change(field(form, "url"), "https://telemost.yandex.ru/j/1");
  await submit(form);
  await waitForPage(page!, () => text().includes(title) || !!alert());
  expect(alert()).toBeUndefined();
}

it("a removed meeting can be announced again after own edits of the old one (EV-05)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  mock.state.meetings = mock.state.meetings.filter(item => !(item.owner_kind === "event" && item.owner_id === event.event_id));
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, { path: `/meetings/event/${event.event_id}` });
  await waitForPage(page, () => text().includes("Созвон пока не назначен."));
  await announce("Первый созвон");
  // An own edit moves the removal's baseline: the removal is not stopped by a conflict.
  await announce("Первый созвон, уточнено");
  const first = mock.state.meetings.find(item => item.owner_id === event.event_id)!;
  expect(first.revision).toBe(2);
  await submit(button("Снять объявление")!.closest("form")!);
  await act(async () => button("Да, снять")!.click());
  await waitForPage(page, () => text().includes("Созвон пока не назначен.") || !!alert());
  expect(alert()).toBeUndefined();
  // The new announcement starts its own counter; the old one's revisions do not stop it.
  await announce("Новый созвон");
  const second = mock.state.meetings.find(item => item.owner_id === event.event_id)!;
  expect(second.title).toBe("Новый созвон");
  expect(second.meeting_id).not.toBe(first.meeting_id);
  await announce("Новый созвон, уточнено");
  expect(mock.state.meetings.find(item => item.owner_id === event.event_id)!.revision).toBe(2);
});
