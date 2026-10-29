import { expect, it } from "vitest";
import { createFixtures } from "../mocks/fixtures";
import { wireIssues } from "./wireContract";

it("rejects extra public fields at every level, including array items", () => {
  const event = createFixtures("chair").events[0];
  expect(wireIssues("Event", { ...event, private_score: 9 })).toContain("Event.private_score: unexpected field");
  const nested = structuredClone(event);
  Object.assign(nested.leaders[0].user, { private_score: 9 });
  expect(wireIssues("Event", nested)).toContain("Event.leaders[0].user.private_score: unexpected field");
  const task = createFixtures("chair").tasks[0];
  Object.assign(task.assignments[0], { hours: 4, evaluation: 1 });
  const issues = wireIssues("Task", task);
  expect(issues).toContain("Task.assignments[0].hours: unexpected field");
  expect(issues).toContain("Task.assignments[0].evaluation: unexpected field");
});

it("keeps required, optional and nullable DTO fields exact", () => {
  const task = createFixtures("chair").tasks[0];
  expect(wireIssues("Task", task)).toEqual([]);
  expect(wireIssues("Task", { ...task, season_id: null, deadline_at: null })).toEqual([]);
  expect(wireIssues("UserRef", { user_id: null, display_name: "Архивный участник", avatar_url: null })).toEqual([]);
  expect(wireIssues("RichText", { format: "markdown" })).toContain("RichText.body: expected string");
  expect(wireIssues("RichText", { format: "markdown", body: "", extra: undefined })).toContain("RichText.extra: unexpected field");
});

it("checks each declared union branch without permitting unrelated keys", () => {
  expect(wireIssues("TaskScopeRef", { kind: "queue", id: "service" })).toEqual([]);
  expect(wireIssues("TaskScopeRef", { kind: "block", id: "team" })).toEqual([]);
  expect(wireIssues("TaskScopeRef", { kind: "queue", id: "service", private_score: 1 })).not.toEqual([]);
  expect(wireIssues("UserRef", [])).toEqual(["UserRef: expected object"]);
});

it("validates declared legacy compatibility fields without opening arbitrary metadata", () => {
  const session = createFixtures("chair").session;
  expect(wireIssues("Session", { ...session, permissions: [], leadership: { is_chair: true, is_deputy: false }, super_user: true, admin: false, pgas_admin: false })).toEqual([]);
  expect(wireIssues("Session", { ...session, permissions: [1] })).not.toEqual([]);
  expect(wireIssues("Session", { ...session, leadership: { is_chair: true, is_deputy: false, private_score: 3 } })).not.toEqual([]);
});
