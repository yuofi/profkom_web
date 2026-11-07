import { expect, it } from "vitest";
import { emptyCriteria } from "./api/contract";
import type { FeatureScope, KkrTemplate } from "./api/profileFeatures.api";
import { templateFits, templateRefused } from "./kkrTemplates";
import { ApiError } from "./api/request";

const owner = { user_id: 101, display_name: "Анна Смирнова", avatar_url: null };
const row = (scope: FeatureScope | null): KkrTemplate => ({ template_id: scope ? `${scope.kind}-${scope.id}` : "personal", visibility: scope ? "team" : "personal", scope, revision: 1, archived: false, values: { title: "Шаблон", description: "", hours: 1, evaluation: 1, criteria: emptyCriteria() }, author: owner, updated_by: owner });
const personal = row(null), global = row({ kind: "global", id: null, name: "Профком" });
const block = row({ kind: "block", id: "block-7", name: "Медиа" }), event = row({ kind: "event", id: "event-1", name: "Посвят" });
const subevent = row({ kind: "subevent", id: "sub-1", name: "Регистрация" });

it("offers what the server takes: personal, «Весь Профком», the same team and a subevent's own event", () => {
  const fits = (target: Parameters<typeof templateFits>[1]) => [personal, global, block, event, subevent].filter(item => templateFits(item, target)).map(item => item.template_id);
  expect(fits({ kind: "chair", id: null })).toEqual(["personal", "global-null"]);
  expect(fits({ kind: "block", id: "block-7" })).toEqual(["personal", "global-null", "block-block-7"]);
  // A block task names its block by name.
  expect(fits({ kind: "block", id: "Медиа" })).toEqual(["personal", "global-null", "block-block-7"]);
  expect(fits({ kind: "block", id: "block-8" })).toEqual(["personal", "global-null"]);
  expect(fits({ kind: "event", id: "event-1" })).toEqual(["personal", "global-null", "event-event-1"]);
  expect(fits({ kind: "subevent", id: "sub-1", eventId: "event-1" })).toEqual(["personal", "global-null", "event-event-1", "subevent-sub-1"]);
  expect(fits({ kind: "subevent", id: "sub-1" })).toEqual(["personal", "global-null", "subevent-sub-1"]);
  expect(fits({ kind: "subevent", id: "sub-2", eventId: "event-2" })).toEqual(["personal", "global-null"]);
  // No chosen team yet: only what fits any team.
  expect(fits({ kind: "block", id: "" })).toEqual(["personal", "global-null"]);
});

it("names only the template refusals of a save", () => {
  for (const code of ["template_changed", "template_archived", "template_scope_mismatch", "template_unavailable"]) expect(templateRefused(new ApiError("x", 409, code))).toBe(true);
  expect(templateRefused(new ApiError("x", 409, "revision_conflict"))).toBe(false);
  expect(templateRefused(new Error("x"))).toBe(false);
});
