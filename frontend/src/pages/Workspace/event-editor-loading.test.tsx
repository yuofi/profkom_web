// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { EventsListPage, EventCreatePage } from "./EventPages";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";

const { editorModuleLoaded } = vi.hoisted(() => ({ editorModuleLoaded: vi.fn() }));
vi.mock("./EventEditor", async importOriginal => {
  editorModuleLoaded();
  return await importOriginal<typeof import("./EventEditor")>();
});
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();mock?.restore(); });

it("loads the real event editor only after an authorized create action and retains its save flow", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<EventCreatePage />, { role: "organizer" });await waitForPage(page);
  expect(page.container.textContent).toContain("Создавать мероприятия могут председатель");
  expect(editorModuleLoaded).not.toHaveBeenCalled();
  await page.cleanup();mock.restore();

  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/events" element={<EventsListPage />} /><Route path="/events/new" element={<EventCreatePage />} /><Route path="/events/:id" element={<h1>Сохранённое мероприятие</h1>} /></Routes>, { role: "chair", path: "/events" });
  await waitForPage(page);expect(editorModuleLoaded).not.toHaveBeenCalled();
  expect(page.container.querySelector('[name="description"]')).toBeNull();
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/events/new"]')!.click());
  await waitForPage(page, () => !!page!.container.querySelector('[name="description"]'));
  expect(editorModuleLoaded).toHaveBeenCalledOnce();
  await change(field(page.container, "title"), "Отложенный редактор");
  await change(field(page.container, "description"), "Сохранить **Markdown**");
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(mock.state.events.at(-1)).toMatchObject({ title: "Отложенный редактор", description: { body: "Сохранить **Markdown**" } });
});
