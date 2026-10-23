// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant, liveCloseSeasons } from "../../test/liveApi";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { UnresolvedPage } from "./TaskPages";
import { ReportPage } from "./ReportPages";
import { reportsApi } from "../../utils/api/reports.api";
import { SummaryPage } from "./SeasonPages";
import { invalidateWorkspace } from "../../utils/api/invalidation";
import { act } from "react";
import { ProfileEditPage } from "../ProfileEditPage/ProfileEditPage";
import { UserContext } from "../../utils/me";
import { authApi } from "../../utils/api/auth.api";
import { HelmetProvider } from "react-helmet-async";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });

it("INT-01: real session opens only the manager's queue and loses access with the role", async () => {
  const master = await liveParticipant("master"), member = await liveParticipant("member");
  await liveLogin();
  const block = (await membershipApi.blocks()).find(b => b.name === "Integration IT")!;
  await eventsApi.blockLeader(block.block_id, master.user_id, { expected_revision: block.revision });
  let seasons = (await seasonsApi.list()).items;
  if (!seasons.some(s => s.state === "open")) {
    const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({ title: "Integration acceptance", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 20 * 86400000).toISOString() });
    await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });
    seasons = (await seasonsApi.list()).items;
  }
  await liveLogin(member.email);
  let application = await membershipApi.join(block.block_id);
  await liveLogin();
  application = await membershipApi.requestCommand(application.request_id, "hr-approve", { expected_revision: application.revision });
  await liveLogin(master.email);
  await membershipApi.requestCommand(application.request_id, "block-approve", { expected_revision: application.revision });
  const task = await tasksApi.create({ season_id: seasons.find(s => s.state === "open")!.season_id,
    scope: { kind: "block", id: block.block_id }, title: "INT-01 оставшаяся работа", description: richText("Real HTTP"),
    deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{ user_id: member.user_id, hours: 1 }] });
  await liveLogin(member.email); await membershipApi.leave(block.block_id);
  const session = await liveLogin(master.email);
  expect(session.capabilities).toContain("view_unresolved_assignments");
  page = await mountWorkspace(<Routes><Route path="/tasks/unresolved" element={<UnresolvedPage />} /></Routes>, { path: "/tasks/unresolved", session });
  await waitForPage(page, () => !!page!.container.textContent?.includes(task.title));
  expect(page.container.textContent).toContain(task.title);
  expect(page.container.textContent).not.toContain("Нет доступа к очереди");
  await page.cleanup(); page = undefined;
  await liveLogin();
  const current = await membershipApi.block(block.block_id);
  await eventsApi.blockLeader(block.block_id, member.user_id, { expected_revision: current.revision });
  const removed = await liveLogin(master.email);
  expect(removed.capabilities).not.toContain("view_unresolved_assignments");
  await expect(tasksApi.unresolved()).rejects.toMatchObject({ status: 403 });
});

it("INT-02: real report readers can open both publications without seeing the shared draft", async () => {
  const author = await liveParticipant("report-author");
  await liveLogin();
  const season = (await seasonsApi.list()).items.find(s => s.state === "open")!;
  const event = await eventsApi.create({ season_id: season.season_id, title: "Report publications", description: richText() });
  await eventsApi.leaders("events", event.event_id, [author.user_id], { expected_revision: event.revision });
  await liveLogin(author.email);
  let report = await reportsApi.create({ owner_kind: "event", owner_id: event.event_id, kind: "regular", title: "Версии отчёта HTTP", content: richText("Первая публикация HTTP"), file_ids: [] });
  report = await reportsApi.publish(report.report_id, { expected_revision: report.revision });
  report = await reportsApi.update(report.report_id, { expected_revision: report.revision, content: richText("Вторая публикация HTTP") });
  report = await reportsApi.publish(report.report_id, { expected_revision: report.revision });
  await reportsApi.update(report.report_id, { expected_revision: report.revision, content: richText("Скрытый черновик HTTP") });
  const reader = await liveLogin();
  const read = await reportsApi.get(report.report_id);
  expect(read.capabilities).toContain("view_report_versions");
  expect(read.capabilities).not.toContain("edit_report");
  page = await mountWorkspace(<Routes><Route path="/reports/:id" element={<ReportPage />} /></Routes>, { path: `/reports/${report.report_id}`, session: reader });
  await waitForPage(page, () => !!page!.container.textContent?.includes("Первая публикация HTTP"));
  expect(page.container.textContent).toContain("Опубликованные версии");
  expect(page.container.textContent).toContain("Первая публикация HTTP");
  expect(page.container.textContent).toContain("Вторая публикация HTTP");
  expect(page.container.textContent).not.toContain("Скрытый черновик HTTP");
});

it("INT-03: closed correction keeps old totals immutable and exposes provenance through the actual UI", async () => {
  await liveCloseSeasons();
  const session = await liveLogin();
  const closed = (await seasonsApi.list()).items.find(s => s.state === "closed")!;
  let summary = await seasonsApi.summary(closed.season_id);
  const old = await seasonsApi.summaryVersion(closed.season_id, summary.version);
  const row = summary.rows.find(r => r.user.user_id !== null)!;
  summary = await seasonsApi.decisions(closed.season_id, row.user.user_id!, { expected_version: summary.version, decisions: ["nice"], reason: "INT-03 новая отметка" });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/summary" element={<SummaryPage />} /></Routes>, { path: `/seasons/${closed.season_id}/summary`, session });
  await waitForPage(page, () => !!page!.container.querySelector('select'));
  await change(page.container.querySelector('select')!, String(old.version));
  await waitForPage(page, () => !!page!.container.querySelector('[aria-label="Историческая сводная"]'));
  let historical = page.container.querySelector('[aria-label="Историческая сводная"]')!;
  expect(historical.textContent).toContain(`Историческая версия ${old.version}`);
  expect(historical.textContent).toContain(old.reason);
  expect(historical.querySelectorAll('form')).toHaveLength(0);
  const oldText = historical.textContent;
  await seasonsApi.decisions(closed.season_id, row.user.user_id!, { expected_version: summary.version, decisions: ["golden_red_bull"], reason: "INT-03 ещё одна коррекция" });
  await act(async () => invalidateWorkspace(page!.client));
  await waitForPage(page);
  expect((await seasonsApi.summaryVersion(closed.season_id, old.version))).toEqual(old);
  historical = page.container.querySelector('[aria-label="Историческая сводная"]')!;
  expect(historical.textContent).toBe(oldText);
  expect(page.container.querySelector('select')!.querySelectorAll('option').length).toBeGreaterThan(3);
});

it("INT-04: a real approved profile with @username and no patronymic can save one field", async () => {
  const person = await liveParticipant("profile"); const session = await liveLogin(person.email);
  const profile = (await authApi.getMe()).data;
  expect(profile.patronymic).toBe(""); expect(profile.tg).toBe("@profkom_test");
  page = await mountWorkspace(<HelmetProvider><UserContext.Provider value={profile}><ProfileEditPage /></UserContext.Provider></HelmetProvider>, { session });
  await change(field(page.container, "surname"), "Обновлена без отчества");
  await submit(page.container.querySelector('form')!);
  await waitForPage(page, () => !!page!.container.textContent?.includes("Профиль успешно обновлён"));
  expect(page.container.textContent).toContain("Профиль успешно обновлён");
  const read = (await authApi.getMe()).data;
  expect(read.surname).toBe("Обновлена без отчества"); expect(read.patronymic).toBe(""); expect(read.tg).toBe(profile.tg);
});
