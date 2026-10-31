// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { EventPage } from "./EventPages";
import { BlockPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });
const count = (text: string, part: string) => text.split(part).length - 1;

it("a leader's deputies are one labelled line under the leader and are edited in a dialog with the leader's revision (EV-11)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0], leader = event.leaders[0];
  const save = vi.spyOn(eventsApi, "deputies").mockResolvedValue({ ...leader, deputy_user_ids: [105, 104], revision: leader.revision + 1 });
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /></Routes>, { path: `/events/${event.event_id}` });await waitForPage(page);
  const header = page.container.querySelector('[class*="headerLeaders"]')!;
  expect(count(header.textContent!, "Заместители")).toBe(event.leaders.length);
  expect(header.querySelector("details, form")).toBeNull();
  await act(async () => header.querySelector<HTMLButtonElement>(`button[aria-label="Изменить заместителей: ${leader.user.display_name}"]`)!.click());
  await waitForPage(page, () => !!document.querySelector("dialog form"));
  // The dialog is outside the branded header, so the header's button styles do not apply to it.
  expect(document.querySelector("dialog")!.closest("header")).toBeNull();
  const form = document.querySelector<HTMLFormElement>("dialog form")!;
  expect(document.querySelector("dialog")?.textContent).toContain(`Руководитель: ${leader.user.display_name}`);
  await pick(form, "users", "104");await submit(form);
  await waitForPage(page, () => !document.querySelector("dialog"));
  expect(save).toHaveBeenCalledWith(leader.role_assignment_id, [105, 104], { expected_revision: leader.revision });
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
