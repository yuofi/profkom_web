// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { SessionContext } from "../../utils/session";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { change, field, settle, waitForPage } from "../../test/workspace";
import { MeritForm } from "./MeritPages";

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
  await act(async () => button.click()); await settle();
}
const select = (container: HTMLElement, label: string) => [...container.querySelectorAll("label")].find((item) => item.textContent?.trim().startsWith(label))!.querySelector<HTMLSelectElement>("select")!;

it.each(["source", "scope"])("changing merit %s requires confirmation and preserves fields on stay or failed save", async (kind) => {
  const fixture = createFixtures("chair");
  const mock = installMockTransport("chair", { delay: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [
    { path: "/", element: <SessionContext.Provider value={{ session: fixture.session, loading: false, error: null, refresh: () => {} }}><MeritForm seasonId={fixture.seasons.find((item) => item.state === "open")!.season_id} /></SessionContext.Provider> },
  ] }]);
  cleanup = async () => { await act(async () => root.unmount()); router.dispose(); client.clear(); container.remove(); mock.restore(); };
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  await waitForPage({ client, container });
  const scopes = [...select(container, "Область работы").options].filter((item) => item.value);
  expect(scopes.length).toBeGreaterThan(1);
  await change(select(container, "Область работы"), scopes[0].value);
  await change(field(container, "title"), "Сохранить введённое название");
  const contextSelect = () => select(container, kind === "source" ? "Вид записи" : "Область работы");
  const previous = contextSelect().value;
  const next = kind === "source" ? [...contextSelect().options].find((item) => item.value && item.value !== previous)!.value : scopes[1].value;
  await change(contextSelect(), next);
  expect(container.querySelector("dialog")).not.toBeNull();
  await click(container, "Остаться");
  expect(field(container, "title").value).toBe("Сохранить введённое название");
  expect(contextSelect().value).toBe(previous);
  await change(contextSelect(), next);
  await click(container, "Сохранить и перейти");
  expect(container.textContent).toContain("Изменения не сохранены");
  expect(field(container, "title").value).toBe("Сохранить введённое название");
  expect(contextSelect().value).toBe(previous);
  await click(container, "Остаться");
  await change(contextSelect(), next);
  await click(container, "Уйти без сохранения");
  expect(contextSelect().value).toBe(next);
  expect(field(container, "title").value).toBe("");
});
