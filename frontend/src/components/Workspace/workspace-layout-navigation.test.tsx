// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle } from "../../test/workspace";
import { WorkspaceLayout } from "./WorkspaceLayout";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; });

it("the collapsible mobile menu has a profile entry and closes after opening it", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}>
    <Route path="/" element={<p>Главная страница</p>} />
    <Route path="/profile" element={<p>Профиль открыт</p>} />
  </Route></Routes>);
  await settle();
  const mobile = page.container.querySelector("aside details")!;
  await act(async () => { mobile.setAttribute("open", ""); });
  const links = mobile.querySelectorAll<HTMLAnchorElement>('a[href="/profile"]');
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("aria-label")).toBe("Мой профиль");
  await act(async () => links[0].click());
  expect(page.container.textContent).toContain("Профиль открыт");
  expect(mobile.hasAttribute("open")).toBe(false);
});


it("both desktop and mobile navigation name the task section Трекер", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/tasks/queues" element={<h1>Очереди</h1>} /></Route></Routes>, { path: "/tasks/queues" });
  await settle();
  const links = page.container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Основная навигация"] a[href="/tasks"]');
  expect(links).toHaveLength(2);
  for (const link of links) { expect(link.textContent).toContain("Трекер");expect(link.textContent).not.toContain("Задачи");expect(link.getAttribute("aria-current")).toBe("true"); }
  expect(page.container.querySelector("h1")?.textContent).toBe("Очереди");
});
