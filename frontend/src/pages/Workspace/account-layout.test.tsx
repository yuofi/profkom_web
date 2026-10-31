// @vitest-environment jsdom
import MockAdapter from "axios-mock-adapter";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { api } from "../../utils/api";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle } from "../../test/workspace";
import { AccountStatePage, PasswordChangePage } from "./SessionPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, adapter: MockAdapter | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;adapter?.restore();adapter = undefined; });
const stamp = () => page!.container.querySelector('[aria-current="page"]')?.textContent;

it("GL-18: a rejected application has its own frame and stamp on any address, the reason and «Выйти»", async () => {
  const f = createFixtures("rejected");
  adapter = new MockAdapter(api);
  adapter.onGet("/registrations/me").reply(200, { ...f.registration, status: "rejected", rejection_reason: "Нет номера группы" });
  page = await mountWorkspace(<Routes><Route path="*" element={<AccountStatePage />} /></Routes>, { role: "rejected", path: "/materials" });
  await settle();await settle();
  // The mark of the site, and a stamp that names this screen, not the section in the address.
  expect(page.container.textContent).toContain("ПрофкомВМК МГУ");
  expect(stamp()).toBe("Профком ВМК · Регистрация");expect(page.container.textContent).not.toContain("Материалы");
  expect(page.container.querySelector("a")).toBeNull();
  expect(page.container.textContent).toContain("Причина: Нет номера группы");
  expect([...page.container.querySelectorAll("button")].map(node => node.textContent)).toContain("Выйти");
});

it("GL-18: the temporary password screen uses the same frame", async () => {
  page = await mountWorkspace(<Routes><Route path="*" element={<PasswordChangePage />} /></Routes>, { path: "/tasks" });
  await settle();
  expect(stamp()).toBe("Профком ВМК · Смена пароля");
  expect(page.container.querySelector("h1")?.textContent).toBe("Смените временный пароль");
});
