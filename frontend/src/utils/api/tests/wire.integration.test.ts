import { expect, it } from "vitest";
import { wireIssues } from "../../../test/wireContract";
import { liveLogin, liveParticipant, liveCloseSeasons, CLOSES_SEASONS_TIMEOUT } from "../../../test/liveApi";
import { authApi } from "../auth.api";
import { sessionApi } from "../session.api";
import { membershipApi } from "../membership.api";
import { seasonsApi } from "../seasons.api";
import { eventsApi } from "../events.api";
import { tasksApi } from "../tasks.api";
import { reportsApi } from "../reports.api";
import { materialsApi } from "../materials.api";
import { directoryApi } from "../directory.api";
import { workspaceApi } from "../workspace.api";
import { contactsApi } from "../contacts.api";
import { richText, emptyCriteria } from "../contract";

it("INT-06: actual response shapes, null relations and populated IDs match the public DTOs", async () => {
  const errors: string[] = [];
  const check = <T,>(name: string, value: T): T => { errors.push(...wireIssues(name, value)); return value; };
  const person = await liveParticipant("wire");
  let chair = check("Session", await liveLogin());
  check("Leadership", await sessionApi.leadership());
  const blocks = await membershipApi.blocks(); blocks.forEach(b => check("Block", b));
  check("ParticipantCategory", await membershipApi.category(person.user_id));
  const presets = await directoryApi.avatars(); presets.items.forEach(p => check("AvatarPreset", p));
  check("ContactInfoOut", await directoryApi.avatar({ preset_id: presets.items[0].preset_id }));
  (await directoryApi.contacts()).forEach(p => check("ContactInfoOut", p));
  check("MeOut", (await authApi.getMe()).data);
  check("UserOut", await contactsApi.update(chair.user_id, { surname: "Тестовый" }));
  check("FormerContact", await directoryApi.saveFormer({ surname: "Бывший", name: "Участник", phone: "", email: "former@example.com", tg: "", vk: "", participation_periods: [{ from_year: 2021, to_year: 2023 }] }));
  await liveLogin(person.email); check("RegistrationApplication", await membershipApi.registration());
  const application = check("BlockRequest", await membershipApi.join(blocks.find(b => b.is_hr)!.block_id));
  await liveLogin(); check("BlockRequest", await membershipApi.requestCommand(application.request_id, "hr-approve", { expected_revision: application.revision }));

  let season = (await seasonsApi.list()).items.find(s => s.state === "open");
  if (!season) {
    const planned = (await seasonsApi.list()).items.find(s => s.state === "planned") ?? await seasonsApi.create({ title: "Wire contract", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 20 * 86400000).toISOString() });
    await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });
    season = await seasonsApi.current();
  }
  check("Season", season);
  const event = check("Event", await eventsApi.create({ season_id: season.season_id, title: "Wire event", description: richText() }));
  await eventsApi.leaders("events", event.event_id, [chair.user_id], { expected_revision: event.revision });
  const sub = check("Subevent", await eventsApi.createSubevent(event.event_id, { title: "Wire subevent", description: richText() }));
  (await eventsApi.series()).items.forEach(s => check("ReportSeries", s));
  check("Meeting", await eventsApi.saveMeeting("events", event.event_id, { title: "Wire meeting", starts_at: new Date(Date.now() + 86400000).toISOString(), join_url: "https://example.com/meeting" }));
  let report = check("Report", await reportsApi.create({ owner_kind: "event", owner_id: event.event_id, kind: "regular", title: "Wire report", content: richText("Published"), file_ids: [] }));
  report = check("Report", await reportsApi.publish(report.report_id, { expected_revision: report.revision }));
  (await reportsApi.versions(report.report_id)).items.forEach(v => check("ReportVersion", v));
  let material = check("Material", await materialsApi.create({ kind: "general", title: "Wire material", description: "Test", content: richText("Content") }));
  material = check("Material", await materialsApi.publish(material.material_id, { expected_revision: material.revision }));
  const task = check("Task", await tasksApi.create({ season_id: season.season_id, scope: { kind: "block", id: blocks.find(b => b.is_hr)!.block_id }, title: "Wire task", description: richText(), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{ user_id: chair.user_id, hours: 1 }] }));
  check("TaskInputs", await tasksApi.inputs(task.task_id));
  let assignment = task.assignments[0]; check("AssessmentInputs", await tasksApi.assessment(assignment.assignment_id));
  assignment = check("Assignment", await tasksApi.command(assignment.assignment_id, "submit", { expected_revision: assignment.revision, text: richText("Done") }));
  check("Assignment", await tasksApi.command(assignment.assignment_id, "accept", { expected_revision: assignment.revision, evaluation: 1 }));
  check("Comment", await tasksApi.comment(task.task_id, richText("Comment")));
  check("Merit", await seasonsApi.createMerit({ season_id: season.season_id, source_kind: "chair_merit", title: "Wire merit", description: richText("Contribution"), assigned_at: new Date(Date.now() - 3600000).toISOString(), deadline_at: new Date(Date.now() + 3600000).toISOString(), criteria: emptyCriteria(), recipients: [{ user_id: person.user_id, hours: 1, evaluation: 1, completed_at: new Date(Date.now() - 60000).toISOString() }], reason: "Wire acceptance" }));
  (await seasonsApi.assessments({ season_id: season.season_id })).items.forEach(c => check("Contribution", c));
  check("Dashboard", await workspaceApi.dashboard());
  (await workspaceApi.calendar(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 3 * 86400000).toISOString())).items.forEach(c => check("CalendarItem", c));
  (await workspaceApi.notifications()).items.forEach(n => check("Notification", n));
  await liveCloseSeasons();
  const closedSeasons = (await seasonsApi.list()).items.filter(s => s.state === "closed");
  expect(closedSeasons.length).toBeGreaterThan(0);
  for (const s of closedSeasons) {
    check("SeasonSummary", await seasonsApi.summary(s.season_id));
    (await seasonsApi.bonuses(s.season_id)).items.forEach(b => check("MasterBonus", b));
    const versions = await seasonsApi.summaryVersions(s.season_id);
    for (const v of versions.items) { check("SummaryVersionMetadata", v); check("SummaryVersionSnapshot", await seasonsApi.summaryVersion(s.season_id, v.version)); }
  }
  chair = await liveLogin();
  expect(chair.user_id).toBeGreaterThan(0); expect(sub.subevent_id).toBeTruthy(); expect(report.published_version).toBe(1); expect(material.published_content).not.toBeNull();
  expect(errors).toEqual([]);
}, CLOSES_SEASONS_TIMEOUT);
