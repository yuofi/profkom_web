import { afterEach, describe, expect, it } from "vitest";
import { createFixtures, mockRoles } from "../../../mocks/fixtures";
import { installMockTransport } from "../../../mocks/transport";
import { sessionApi } from "../session.api";
import { tasksApi } from "../tasks.api";
import { reportsApi } from "../reports.api";
import { seasonsApi } from "../seasons.api";
import { filesApi } from "../files.api";
import { membershipApi } from "../membership.api";
import { page, normalizeApiError, ApiError } from "../request";
import { richText, emptyCriteria } from "../contract";
import { QueryClient } from "@tanstack/react-query";
import { clearPrivateCache } from "../invalidation";
import { eventsApi } from "../events.api";
import { workspaceApi } from "../workspace.api";
import { materialsApi } from "../materials.api";
import { directoryApi } from "../directory.api";
import { contactsApi } from "../contacts.api";
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(() => {
  mock?.restore();
  mock = undefined;
});
const useMock = (
  role: Parameters<typeof installMockTransport>[0] = "organizer",
) => (mock = installMockTransport(role, { delay: 0 }));

describe("Safe contract fixtures", () => {
  it.each(mockRoles)(
    "%s never puts assessment inputs or scores in public tasks",
    (role) => {
      const fixture = createFixtures(role);
      for (const task of fixture.tasks) {
        for (const hidden of ["criteria", "assigned_at", "score", "kkr_score"])
          expect(task).not.toHaveProperty(hidden);
        for (const assignment of task.assignments)
          for (const hidden of [
            "hours",
            "evaluation",
            "effective_completed_at",
            "score",
          ])
            expect(assignment).not.toHaveProperty(hidden);
      }
      expect(fixture.profile).not.toHaveProperty("kkr_score");
    },
  );
  it("HR deputy does not inherit global KKR or HR-review capabilities", () => {
    const caps = createFixtures("hr-deputy").session.capabilities;
    expect(caps).not.toContain("view_kkr");
    expect(caps).not.toContain("hr_review_request");
  });
  it("never grants chair-only actions to chair deputies", () => {
    const caps = createFixtures("chair-deputy").session.capabilities;
    expect(caps).toContain("view_summary");
    expect(caps).not.toContain("transfer_chair");
    expect(caps).not.toContain("close_season");
  });
});
describe("API commands through mock transport", () => {
  it("keeps newly-created public tasks free of hidden inputs and permits a manager to perform own work", async () => {
    useMock("leader");
    const task = await tasksApi.create({
      season_id: "season-1",
      scope: { kind: "subevent", id: "subevent-1" },
      title: "Своя задача",
      description: richText("Описание"),
      deadline_at: "2026-10-25T12:00:00Z",
      criteria: emptyCriteria(),
      assignees: [{ user_id: 102, hours: 4 }],
    });
    expect(task).not.toHaveProperty("criteria");
    expect(task).not.toHaveProperty("assignees");
    const own = task.assignments[0];
    const submitted = await tasksApi.command(own.assignment_id, "submit", {
      expected_revision: own.revision,
      text: richText("Сделано"),
    });
    expect(submitted.capabilities).toContain("review_assignment");
    await tasksApi.command(own.assignment_id, "accept", {
      expected_revision: submitted.revision,
      evaluation: 1,
    });
    expect((await tasksApi.assessment(own.assignment_id)).hours).toBe(4);
  });
  it("lets the HR master read every task as well as the KKR (АВ-3)", async () => {
    useMock("hr");
    expect((await tasksApi.list({ mine: false })).items.map((x) => x.task_id)).toContain("task-1");
    expect((await tasksApi.get("task-1")).task_id).toBe("task-1");
    expect(
      (await seasonsApi.assessments({ season_id: "season-1" })).items.length,
    ).toBeGreaterThan(0);
  });
  it("loads all cursor pages and rejects a repeated cursor instead of losing work", async () => {
    const fixture = useMock();
    fixture.adapter.resetHandlers();
    fixture.adapter
      .onGet("/tasks")
      .reply((config) =>
        config.params?.cursor === "next"
          ? [200, { items: [{ task_id: "second" }], next_cursor: null }]
          : [200, { items: [{ task_id: "first" }], next_cursor: "next" }],
      );
    expect((await tasksApi.list()).items.map((t) => t.task_id)).toEqual([
      "first",
      "second",
    ]);
    fixture.adapter.resetHandlers();
    fixture.adapter
      .onGet("/tasks")
      .reply(200, { items: [], next_cursor: "loop" });
    await expect(tasksApi.list()).rejects.toMatchObject({
      code: "pagination_error",
    });
  });
  it("provides six local avatar choices and a default, and persists the own choice", async () => {
    useMock();
    const avatars = await directoryApi.avatars();
    expect(avatars.items.length).toBeGreaterThanOrEqual(7);
    expect(
      avatars.items.every((a) => a.image_url.startsWith("/avatars/")),
    ).toBe(true);
    await directoryApi.avatar({ preset_id: "leaf" });
    expect(
      (await directoryApi.contacts()).find((p) => p.user_id === 101)?.photo_url,
    ).toBe("/avatars/leaf.svg");
  });
  it("keeps former-contact editing distinct from active profiles and account restoration", async () => {
    useMock();
    const former = (await directoryApi.former()).items[0];
    await expect(
      directoryApi.saveFormer(former, former.contact_id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      contactsApi.update(105, { name: "Чужой профиль" }),
    ).rejects.toMatchObject({ response: { status: 403 } });
    await expect(directoryApi.restore(110, [])).rejects.toMatchObject({
      status: 403,
    });
  });
  it("protects the current chair and requires an explicit master conflict resolution", async () => {
    useMock("chair");
    await expect(directoryApi.archive(104, "Тест")).rejects.toMatchObject({
      code: "chair_transfer_required",
    });
    await expect(directoryApi.restore(110, [])).rejects.toMatchObject({
      code: "master_conflict",
    });
    await directoryApi.restore(110, [
      { block_id: "block-info", keep_user_id: 102 },
    ]);
    expect((await directoryApi.archived()).items).toEqual([]);
  });
  it("round trips custom Markdown unchanged while keeping the old material publication", async () => {
    useMock("leader");
    const material = await materialsApi.get("material-1");
    const source =
      "**Жирный** и *курсив*\n\n- [Ссылка](https://example.com)\n\n```gallery\n/avatars/sun.svg | Подпись\n```\n\n```chip\nИмя: Анна\n```\n";
    const draft = await materialsApi.update(material.material_id, {
      expected_revision: material.revision,
      content: richText(source),
    });
    expect(draft.published_content).toEqual(material.published_content);
    expect(draft.draft_content?.body).toBe(source);
    await materialsApi.publish(material.material_id, {
      expected_revision: draft.revision,
    });
    expect(
      (await materialsApi.get(material.material_id)).published_content?.body,
    ).toBe(source);
  });
  it("denies an unassigned material editor and removes stale draft fields after revocation", async () => {
    const fixture = useMock("editor");
    await expect(
      materialsApi.update("material-1", {
        expected_revision: 1,
        content: richText("Чужой гайд"),
      }),
    ).rejects.toMatchObject({ status: 403 });
    fixture.state.materials[0].draft_content = richText("Закрытый черновик");
    expect(await materialsApi.get("material-1")).not.toHaveProperty(
      "draft_content",
    );
  });
  it("requires separate HR and master decisions and resets the stage deadline", async () => {
    const fixture = useMock("hr");
    const request = await membershipApi.join("block-info");
    const approvedHr = await membershipApi.requestCommand(
      request.request_id,
      "hr-approve",
      { expected_revision: request.revision },
    );
    expect(approvedHr.state).toBe("pending_block");
    expect(approvedHr.substitute_available_at).toBe("2026-10-21T12:00:00.000Z");
    expect(
      fixture.state.blocks[0].members.some((m) => m.user.user_id === 103),
    ).toBe(false);
    await expect(
      membershipApi.requestCommand(request.request_id, "block-approve", {
        expected_revision: approvedHr.revision,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("uses one HR decision for the HR block and never creates membership twice", async () => {
    useMock("hr");
    const request = await membershipApi.join("block-hr");
    const approved = await membershipApi.requestCommand(
      request.request_id,
      "hr-approve",
      { expected_revision: request.revision },
    );
    expect(approved.state).toBe("approved");
    expect(approved.substitute_available_at).toBeNull();
    await expect(
      membershipApi.requestCommand(request.request_id, "hr-approve", {
        expected_revision: approved.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await membershipApi.block("block-hr")).members).toHaveLength(1);
  });
  it.each([
    ["2026-10-17T11:59:59Z", false],
    ["2026-10-17T12:00:00Z", true],
  ] as const)(
    "uses the server capability at the 72-hour boundary %s",
    async (now, allowed) => {
      mock = installMockTransport("chair", { delay: 0, now });
      if (allowed)
        expect(
          (
            await membershipApi.requestCommand("request-1", "block-approve", {
              expected_revision: 1,
            })
          ).state,
        ).toBe("approved");
      else
        await expect(
          membershipApi.requestCommand("request-1", "block-approve", {
            expected_revision: 1,
          }),
        ).rejects.toMatchObject({ status: 403 });
    },
  );
  it("keeps one registration account and does not spend attempts on conflicts", async () => {
    const fixture = useMock("rejected");
    const application = await membershipApi.registration();
    const resubmitted = await membershipApi.resubmit({
      expected_revision: application.revision,
    });
    expect(resubmitted.user_id).toBe(application.user_id);
    await expect(
      membershipApi.resubmit({ expected_revision: application.revision }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await membershipApi.registration()).attempts_used).toBe(2);
    fixture.state.registration.status = "rejected";
    fixture.state.registration.attempts_used = 5;
    await expect(
      membershipApi.resubmit({ expected_revision: resubmitted.revision }),
    ).rejects.toMatchObject({ code: "registration_attempt_limit" });
  });
  it("changes global category without changing the block newcomer flag", async () => {
    useMock("hr");
    const before = await membershipApi.category(101);
    await membershipApi.updateCategory(101, {
      expected_revision: before.revision,
      category: "activist",
      reason: "Решение HR",
    });
    expect((await membershipApi.category(101)).category).toBe("activist");
    expect(
      (await membershipApi.block("block-info")).members[0].block_category,
    ).toBe("junior");
  });
  it("marks notifications without changing their safe target and refreshes the dashboard count", async () => {
    useMock();
    const initial = (await workspaceApi.notifications()).items[0];
    await workspaceApi.read(initial.id);
    expect((await workspaceApi.dashboard()).unread_notification_count).toBe(0);
    expect((await workspaceApi.notifications()).items[0].target).toEqual(
      initial.target,
    );
  });
  it("opens the next season without hiding or changing the previous open work", async () => {
    useMock("chair");
    await seasonsApi.command("season-next", "open", { expected_revision: 1 });
    const seasons = (await seasonsApi.list()).items;
    expect(seasons.find((s) => s.season_id === "season-1")).toMatchObject({
      state: "open",
      is_current: false,
    });
    expect((await tasksApi.list({ mine: false })).items[0].season_id).toBe(
      "season-1",
    );
    expect(seasons.filter((s) => s.is_current)).toHaveLength(1);
  });
  it("moves all event-owned records with the explicit season correction", async () => {
    useMock("chair");
    await seasonsApi.correctSeason({
      object_kind: "event",
      object_id: "event-1",
      expected_revision: 1,
      target_season_id: "season-next",
      reason: "Ошибочный сезон",
    });
    expect((await tasksApi.get("task-1")).season_id).toBe("season-next");
    expect((await reportsApi.get("report-1")).season_id).toBe("season-next");
  });
  it("saves several decisions without archiving an account or altering another season", async () => {
    const fixture = useMock("hr");
    const before = (await seasonsApi.summary("season-1")).version;
    const result = await seasonsApi.decisions("season-1", 101, {
      expected_version: before,
      decisions: ["kick", "nice"],
      reason: "Решение",
    });
    expect(result.rows[0].decisions).toEqual(["kick", "nice"]);
    expect(fixture.state.session.account_state).toBe("active");
    expect(
      (await seasonsApi.summary("season-previous")).rows[0].decisions,
    ).not.toEqual(["kick", "nice"]);
  });
  it("retains old assignment history and records an independent replacement", async () => {
    useMock("leader");
    const result = await tasksApi.reassign("assignment-2", {
      expected_revision: 1,
      new_assignee_user_id: 101,
      hours: 4,
      previous_outcome: "not_completed",
      evaluation: -1,
      reason: "Исполнитель вышел",
    });
    expect(result.previous_assignment.status).toBe("not_completed");
    expect(result.assignment.assignment_id).not.toBe("assignment-2");
    expect(
      (await tasksApi.assessment(result.assignment.assignment_id)).hours,
    ).toBe(4);
    expect((await tasksApi.get("task-1")).assignments).toHaveLength(3);
    expect((await tasksApi.assessment("assignment-2")).evaluation).toBe(-1);
  });
  it("applies bulk hours atomically and rejects a stale item", async () => {
    useMock("leader");
    await expect(
      tasksApi.bulkHours(
        [
          { assignment_id: "assignment-1", expected_revision: 1 },
          { assignment_id: "assignment-2", expected_revision: 0 },
        ],
        9,
        "Правка",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await tasksApi.assessment("assignment-1")).hours).toBe(2);
    await tasksApi.bulkHours(
      [
        { assignment_id: "assignment-1", expected_revision: 1 },
        { assignment_id: "assignment-2", expected_revision: 1 },
      ],
      9,
      "Правка",
    );
    expect((await tasksApi.assessment("assignment-2")).hours).toBe(9);
  });
  it("reviews a submission using its server submission time and retains revision history", async () => {
    const fixture = useMock("leader");
    const a = fixture.state.tasks[0].assignments[0];
    a.status = "submitted";
    a.submissions.push({
      submission_id: "s1",
      submitted_at: "2026-10-17T09:00:00Z",
      text: richText("Результат"),
      links: [],
      files: [],
    });
    const reviewed = await tasksApi.command(
      a.assignment_id,
      "request-revision",
      { expected_revision: 1, review_note: "Уточнить" },
    );
    expect(reviewed.submissions).toHaveLength(1);
    a.status = "submitted";
    await tasksApi.command(a.assignment_id, "accept", {
      expected_revision: reviewed.revision,
      evaluation: 1.5,
    });
    expect(
      (await tasksApi.assessment(a.assignment_id)).effective_completed_at,
    ).toBe("2026-10-17T09:00:00Z");
    await expect(
      tasksApi.command(a.assignment_id, "cancel", {
        expected_revision: a.revision,
        reason: "Повтор",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("copies annual structure with empty assignments and no historical work", async () => {
    useMock("chair");
    const copied = await eventsApi.copy("event-1", {
      season_id: "season-next",
      title: "Новый экземпляр",
    });
    expect(copied.event.event_id).not.toBe("event-1");
    expect(copied.event.leaders).toEqual([]);
    expect(copied.subevents[0].organizer_user_ids).toEqual([]);
    expect(copied.subevents[0].leaders).toEqual([]);
    expect(copied.event.report_series_id).toBe("series-event-1");
  });
  it("preserves a shared deputy at another principal when one leader is removed", async () => {
    useMock("chair");
    let event = await eventsApi.get("event-1");
    event = (await eventsApi.leaders("events", event.event_id, [101, 102], {
      expected_revision: event.revision,
    })) as typeof event;
    await eventsApi.deputies(event.leaders[0].role_assignment_id, [105], {
      expected_revision: event.leaders[0].revision,
    });
    await eventsApi.deputies(event.leaders[1].role_assignment_id, [105], {
      expected_revision: event.leaders[1].revision,
    });
    event = await eventsApi.get("event-1");
    await eventsApi.leaders("events", event.event_id, [102], {
      expected_revision: event.revision,
    });
    expect((await eventsApi.get("event-1")).leaders[0].deputy_user_ids).toEqual(
      [105],
    );
  });
  it("updates chair deputies and revokes global actions after a chair transfer", async () => {
    useMock("chair");
    const initial = await sessionApi.leadership();
    const deputies = await sessionApi.deputies([101, 102], {
      expected_revision: initial.revision,
    });
    expect((await sessionApi.leadership()).deputies).toHaveLength(2);
    await sessionApi.transfer(102, { expected_revision: deputies.revision });
    expect((await sessionApi.leadership()).deputies).toEqual([]);
    expect((await sessionApi.get()).capabilities).not.toContain(
      "transfer_chair",
    );
    await expect(
      sessionApi.deputies([101], { expected_revision: deputies.revision }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps empty and unavailable scenarios explicit without a real-network fallback", async () => {
    mock = installMockTransport("organizer", { delay: 0, scenario: "empty" });
    expect((await tasksApi.list()).items).toEqual([]);
    mock.restore();
    mock = installMockTransport("organizer", { delay: 0, scenario: "error" });
    await expect(tasksApi.list()).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
    });
  });
  it("loads explicit session and cursor list shapes", async () => {
    useMock();
    expect((await sessionApi.get()).account_state).toBe("active");
    const result = await tasksApi.list({ mine: true });
    expect(result.items).toHaveLength(1);
    expect(result.next_cursor).toBeNull();
  });
  it("does not silently adapt a backend array into the new list contract", async () => {
    useMock();
    mock!.adapter.resetHandlers();
    mock!.adapter.onGet("/wrong-shape").reply(200, []);
    await expect(page("/wrong-shape")).rejects.toMatchObject({
      code: "contract_mismatch",
    });
  });
  it("preserves submissions across help, submit and concurrent repeat", async () => {
    useMock();
    const started = await tasksApi.command("assignment-1", "start", {
      expected_revision: 1,
    });
    const help = await tasksApi.command("assignment-1", "request-help", {
      expected_revision: started.revision,
      message: richText("Нужна помощь"),
    });
    expect(help.status).toBe("help_required");
    const submitted = await tasksApi.command("assignment-1", "submit", {
      expected_revision: help.revision,
      text: richText("Готово"),
      links: [],
      file_ids: [],
    });
    expect(submitted.submissions[0].submitted_at).toBe("2026-10-18T12:00:00Z");
    await expect(
      tasksApi.command("assignment-1", "submit", {
        expected_revision: help.revision,
        text: richText("Повтор"),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await tasksApi.get("task-1")).assignments[0].submissions,
    ).toHaveLength(1);
  });
  it("denies hidden inputs and calculated summaries to an organizer", async () => {
    useMock();
    await expect(tasksApi.inputs("task-1")).rejects.toMatchObject({
      status: 403,
    });
    await expect(seasonsApi.summary("season-1")).rejects.toMatchObject({
      status: 403,
    });
  });
  it("keeps published report content while saving a draft", async () => {
    useMock("leader");
    const before = await reportsApi.get("report-1");
    const draft = await reportsApi.update(before.report_id, {
      expected_revision: before.revision,
      content: richText("Новая версия"),
    });
    expect(draft.content).toEqual(before.content);
    expect(draft.draft_content?.body).toBe("Новая версия");
    const published = await reportsApi.publish(draft.report_id, {
      expected_revision: draft.revision,
    });
    expect(published.content.body).toBe("Новая версия");
    expect(published.published_version).toBe(2);
    const history = await reportsApi.versions(published.report_id);
    expect(history.items).toHaveLength(2);
    expect(history.items[0].content).toEqual(before.content);
  });
  it("removes draft access after a report role is revoked, including history reads", async () => {
    const fixture = useMock("leader");
    const report = fixture.state.reports[0];
    report.capabilities = ["view_report_versions"];
    expect(await reportsApi.get(report.report_id)).not.toHaveProperty(
      "draft_content",
    );
    expect(
      (await reportsApi.history(report.report_series_id, 2026)).items[0],
    ).not.toHaveProperty("draft_content");
    await expect(
      reportsApi.update(report.report_id, {
        expected_revision: report.revision,
        content: richText("Старый автор"),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps main meetings hidden from an organizer while showing the team meeting", async () => {
    useMock();
    await expect(eventsApi.meeting("events", "event-1")).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await eventsApi.meeting("subevents", "subevent-1"))?.meeting_id,
    ).toBe("meeting-1");
  });
  it("returns structured blockers without closing the season", async () => {
    useMock("chair");
    const season = (await seasonsApi.list()).items.find(
      (s) => s.season_id === "season-1",
    )!;
    const result = await seasonsApi.command(season.season_id, "begin-summary", {
      expected_revision: season.revision,
    });
    if (!("revision" in result)) throw Error("Unexpected fixture");
    try {
      await seasonsApi.command(season.season_id, "close", {
        expected_revision: result.revision,
      });
      throw Error("Expected blocker");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).blockers[0].kind).toBe("missing_final_report");
    }
  });
  it("requires binary upload before complete and returns a FileRef", async () => {
    useMock();
    const intent = await filesApi.intent({
      owner_kind: "assignment",
      owner_id: "assignment-1",
      purpose: "result",
      name: "result.txt",
      mime_type: "text/plain",
      size_bytes: 4,
    });
    await expect(filesApi.complete(intent.file_id)).rejects.toMatchObject({
      status: 409,
    });
    const file = await filesApi.upload(
      new File(["test"], "result.txt", { type: "text/plain" }),
      { owner_kind: "assignment", owner_id: "assignment-1", purpose: "result" },
    );
    expect(file.name).toBe("result.txt");
    expect(file.size_bytes).toBe(4);
    expect(file).not.toHaveProperty("download_url");
  });
  it("rejects working requests for pending accounts", async () => {
    useMock("pending");
    expect((await sessionApi.get()).account_state).toBe("pending");
    await expect(tasksApi.list()).rejects.toMatchObject({ status: 403 });
    expect((await membershipApi.registration()).status).toBe("pending");
  });
});
it("preserves structured and legacy error messages", () => {
  const error = new ApiError("Изменено", 409, "revision_conflict");
  expect(normalizeApiError(error)).toBe(error);
  expect(normalizeApiError(new Error("Сбой")).message).toBe("Сбой");
});
it("removes cached private objects when access changes", async () => {
  const client = new QueryClient();
  client.setQueryData(["session"], { user_id: 101 });
  client.setQueryData(["tasks", "task-private"], { title: "Закрытые данные" });
  await clearPrivateCache(client);
  expect(client.getQueryData(["tasks", "task-private"])).toBeUndefined();
  expect(client.getQueryData(["session"])).toEqual({ user_id: 101 });
  client.clear();
});
