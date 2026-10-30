// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { membershipApi } from "../../utils/api/membership.api";
import { publicParticipationApi } from "../../utils/api/publicParticipation.api";
import { profileFeaturesApi } from "../../utils/api/profileFeatures.api";
import { ApiError } from "../../utils/api/request";
import { BlockPage, BlockRequestsPage, RegistrationsPage } from "./MembershipPages";
import { ProfileTeams } from "../../components/Workspace/ProfileTeams";
import { ProfileActivity } from "../../components/Workspace/ProfileActivity";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
async function click(element: HTMLElement) { expect(element).toBeDefined();await act(async () => element.click());await waitForPage(page!); }

it("reviews compact registration cards directly and mounts detailed forms only after expansion", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const command = vi.spyOn(membershipApi, "registrationCommand");
  page = await mountWorkspace(<RegistrationsPage />);await waitForPage(page);
  expect(page.container.querySelector("form, select")).toBeNull();
  expect(button("Одобрить")).toBeDefined();expect(button("Отклонить")).toBeDefined();
  await click(page.container.querySelector("summary")!);
  expect(page.container.textContent).toContain("Основа обучения");
  expect(page.container.textContent).toContain("Сбросить лимит отправок");
  await click(button("Одобрить"));
  expect(command).toHaveBeenCalledWith(105, "approve", { expected_revision: 1 });
  expect(page.container.textContent).toContain("заявок нет");
});

it("requires a rejection reason and preserves revision-safe entered text on refusal", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const command = vi.spyOn(membershipApi, "registrationCommand").mockRejectedValue(new ApiError("Запись изменилась", 409, "revision_conflict"));
  page = await mountWorkspace(<RegistrationsPage />);await waitForPage(page);await click(button("Отклонить"));
  const dialog = page.container.querySelector("dialog")!;
  await submit(dialog.querySelector("form")!);await waitForPage(page);
  expect(command).not.toHaveBeenCalled();
  await change(field(dialog, "reason"), "Нужно уточнить контактные данные");await submit(dialog.querySelector("form")!);await waitForPage(page);
  expect(command).toHaveBeenCalledWith(105, "reject", { expected_revision: 1, reason: "Нужно уточнить контактные данные" });
  expect(field(dialog, "reason").value).toBe("Нужно уточнить контактные данные");
  expect(dialog.isConnected).toBe(true);
});

it("keeps all self-leave and active leader removal controls out of block membership", async () => {
  mock = installMockTransport("chair", { delay: 0 });const block = mock.state.blocks[0];
  block.capabilities.push("remove_member", "leave_block");
  block.master!.user = mock.state.user;
  block.master!.deputy_user_ids = [mock.state.people[1].user_id!];
  block.members = [mock.state.user, mock.state.people[1], mock.state.people[2]].map(user => ({ user, block_category: "member" }));
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${block.block_id}` });await waitForPage(page);
  expect(page.container.textContent).not.toContain("Выйти из блока");
  const removers = [...page.container.querySelectorAll<HTMLButtonElement>("button")].filter(item => item.textContent === "Убрать из состава");
  expect(removers).toHaveLength(1);
  expect(removers[0].closest("li")?.textContent).toContain(mock.state.people[2].display_name);
  expect(page.container.querySelector('input[type="file"]')).toBeNull();
});

it("keeps application refresh automatic and links an active request to its block", async () => {
  mock = installMockTransport("chair", { delay: 0 });page = await mountWorkspace(<BlockRequestsPage />);await waitForPage(page);
  expect(button("Обновить")).toBeUndefined();
  const open = mock.state.requests.find(item => ["pending_hr", "pending_block"].includes(item.state))!;
  expect(page.container.querySelector(`a[href="/blocks/${open.block_id}"]`)?.textContent).toBe("Открыть блок");
});

it("bounds and groups public profile teams and removes the cached projection on refusal", async () => {
  mock = installMockTransport("chair", { delay: 0 });const source = mock.state.seasons[0];
  const data = {
    blocks: Array.from({ length: 12 }, (_, i) => ({ block_id: `b-${i}`, name: `Блок ${i}`, roles: ["member" as const] })),
    events: [{ event_id: "e-1", title: "День карьеры", season_id: source.season_id, roles: ["event_leader" as const] }],
  };
  const read = vi.spyOn(publicParticipationApi, "get").mockResolvedValue(data);
  page = await mountWorkspace(<ProfileTeams userId={77} />);await waitForPage(page);
  expect(page.container.querySelectorAll('a[href^="/blocks/"]')).toHaveLength(5);
  expect(page.container.querySelector('a[href="/events/e-1"]')?.textContent).toBe("День карьеры");
  expect(page.container.textContent).toContain(source.title);
  await click(button("Показать все · 12"));expect(page.container.querySelectorAll('a[href^="/blocks/"]')).toHaveLength(12);
  read.mockRejectedValue(new ApiError("Нет доступа", 403));await act(async () => { await page!.client.invalidateQueries({ queryKey: ["participantParticipation", 77] }); });await waitForPage(page);
  expect(page.container.querySelectorAll('a[href^="/blocks/"]')).toHaveLength(0);expect(page.container.textContent).not.toContain("День карьеры");
});

it("folds profile history and limits its expanded DOM without duplicating current teams", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(profileFeaturesApi, "activity").mockResolvedValue({ items: Array.from({ length: 51 }, (_, i) => ({ scope: { kind: "block" as const, id: `b-${i}`, name: `Исторический блок ${i}` }, role: "master", started_at: null, ended_at: null, current: false, observed: false })) });
  page = await mountWorkspace(<ProfileActivity userId={77} hideCurrent />);await waitForPage(page);
  expect(page.container.querySelector("ol")).toBeNull();
  await click(page.container.querySelector("summary")!);expect(page.container.querySelectorAll("ol>li")).toHaveLength(20);
  await click(button("Показать ещё · 31"));expect(page.container.querySelectorAll("ol>li")).toHaveLength(40);
  expect(page.container.querySelector('a[href^="/blocks/"]')).toBeNull();
});
