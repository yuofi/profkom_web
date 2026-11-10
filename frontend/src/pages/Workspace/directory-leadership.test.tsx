// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
import { sessionApi } from "../../utils/api/session.api";
import { ApiError } from "../../utils/api/request";
import type { ContactInfoOut } from "../../utils/api/types";
import { DirectoryPage } from "./DirectoryPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });
const person = (id: number): ContactInfoOut => ({ user_id: id, surname: `Контакт ${id}`, name: "Тест", patronymic: "", kkr_name: "Тест", group_number: "301", location: "", blocks: "", phone: "", vk: "", tg: "", email: `${id}@example.com`, budget: true, in_profcom: true });
const ref = (id: number) => ({ user_id: id, display_name: `Контакт ${id}`, avatar_url: null });
const card = (id: number) => page!.container.querySelector(`h2 a[href="/contacts/${id}"]`)!.closest("section")!;
async function mount() {
  mock = installMockTransport("organizer", { delay: 0 });
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([person(201), person(202), person(203)]);
  vi.spyOn(membershipApi, "categories").mockResolvedValue([201,202,203].map(user_id => ({ user_id, category: "activist", revision: 1, capabilities: [] })));
  const blocks = await membershipApi.blocks();
  vi.spyOn(membershipApi, "blocks").mockResolvedValue([{ ...blocks[0], master: { role_assignment_id: "master", user: ref(202), deputy_user_ids: [], revision: 1, capabilities: [] } }]);
  const leadership = vi.spyOn(sessionApi, "leadership").mockResolvedValue({ chair: ref(201), deputies: [ref(202)], revision: 1, capabilities: [] });
  page = await mountWorkspace(<DirectoryPage />, { role: "organizer" });
  await waitForPage(page);
  return leadership;
}

it("labels chair and deputy above blocks, with filled and outlined crowns; preserves the master crown", async () => {
  const leadership = await mount();
  expect(leadership).toHaveBeenCalledTimes(1);
  expect(card(201).querySelector('[class*="leadership"]')?.textContent).toBe("Председатель");
  expect(card(201).querySelector('[class*="leadershipIcon"]')?.getAttribute("fill")).toBe("currentColor");
  const deputy = card(202).querySelector('[class*="leadership"]')!;
  expect(deputy.textContent).toBe("Заместитель председателя");
  expect(deputy.querySelector("svg")?.getAttribute("fill")).toBe("none");
  expect(deputy.nextElementSibling?.className).toContain("blocks");
  expect(card(202).querySelector('[data-block-master="true"] svg')?.getAttribute("fill")).toBe("none");
  expect(card(203).querySelector('[class*="leadership"]')).toBeNull();
  expect(card(203).querySelector('[data-contact-role]')?.textContent).toBe("Активист");
  expect(card(201).textContent).not.toContain("[]");
});

it("updates transferred roles and removes cached roles after loss of access; retry restores them", async () => {
  const leadership = await mount();
  leadership.mockResolvedValue({ chair: ref(203), deputies: [], revision: 2, capabilities: [] });
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["leadership"] }); });
  await waitForPage(page!);
  expect(card(201).querySelector('[class*="leadership"]')).toBeNull();
  expect(card(202).querySelector('[class*="leadership"]')).toBeNull();
  expect(card(203).querySelector('[class*="leadership"]')?.textContent).toBe("Председатель");
  leadership.mockRejectedValueOnce(new ApiError("Forbidden", 403, "forbidden"));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["leadership"] }); });
  await waitForPage(page!);
  expect(card(203).querySelector('[class*="leadership"]')).toBeNull();
  expect(card(203).querySelector('[data-contact-role]')).toBeNull();
  expect(card(203).textContent).toContain("Роль недоступна");
  const retry = [...page!.container.querySelectorAll("button")].find(b => b.textContent === "Повторить загрузку ролей")!;
  await act(async () => retry.click()); await waitForPage(page!);
  expect(card(203).querySelector('[class*="leadership"]')?.textContent).toBe("Председатель");
});

it("does not present a lower category as the highest role when the block catalogue is unavailable", async () => {
  await mount();
  vi.mocked(membershipApi.blocks).mockRejectedValueOnce(new ApiError("Forbidden", 403, "forbidden"));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["workspaceBlocks"] }); });await waitForPage(page!);
  expect(card(201).querySelector('[data-contact-role]')?.textContent).toBe("Председатель");
  expect(card(202).querySelector('[data-contact-role]')?.textContent).toBe("Зам председателя");
  expect(card(203).querySelector('[data-contact-role]')).toBeNull();
  expect(card(203).textContent).toContain("Роль недоступна");
  const retry = [...page!.container.querySelectorAll("button")].find(b => b.textContent === "Повторить загрузку блоков")!;
  await act(async () => retry.click());await waitForPage(page!);
  expect(card(203).querySelector('[data-contact-role]')?.textContent).toBe("Активист");
});

it("shows exactly one highest role badge, even when leaders are juniors and hold several roles", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const ids = [201, 202, 203, 204, 205];
  vi.spyOn(directoryApi, "contacts").mockResolvedValue(ids.map(person));
  vi.spyOn(membershipApi, "categories").mockResolvedValue(ids.map(user_id => ({ user_id, category: user_id === 204 ? "activist" : "junior", revision: 1, capabilities: [] })));
  const blocks = await membershipApi.blocks();
  vi.spyOn(membershipApi, "blocks").mockResolvedValue([201, 202, 203].map((id, i) => ({ ...blocks[0], block_id: `block-${i}`, name: `Блок ${i}`, master: { role_assignment_id: `master-${i}`, user: ref(id), deputy_user_ids: [], revision: 1, capabilities: [] } })));
  vi.spyOn(sessionApi, "leadership").mockResolvedValue({ chair: ref(201), deputies: [ref(201), ref(202)], revision: 1, capabilities: [] });
  page = await mountWorkspace(<DirectoryPage />, { role: "organizer" });await waitForPage(page);
  expect(ids.map(id => card(id).querySelector('[data-contact-role]')?.textContent)).toEqual(["Председатель", "Зам председателя", "Мастер", "Активист", "Джун"]);
  for (const id of ids) expect(card(id).querySelectorAll('[data-contact-role]')).toHaveLength(1);
  expect(card(202).querySelector('[data-block-master="true"]')).not.toBeNull();
});
