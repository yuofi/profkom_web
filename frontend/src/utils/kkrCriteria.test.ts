import { expect, it } from "vitest";
import { emptyCriteria } from "./api/contract";
import { criteriaFactors, criteriaFromValues, criteriaKeys, criteriaLabels, isCriterion } from "./kkrCriteria";

it("names the five criteria of the owner's table in its order and wording (2026-11-08)", () => {
  expect(Object.entries(criteriaLabels)).toEqual([
    ["unique", "Задача уникальная"],
    ["in_person", "Требует очного присутствия"],
    ["creative", "Задача требует творческого подхода"],
    ["external_communication", "Требует общения с администрацией или людьми вне вуза"],
    ["fixed_time", "Выполняется в определённое время"],
  ]);
  expect(Object.keys(emptyCriteria())).toEqual(criteriaKeys);
});

it("gives every criterion the multiplier of the owner's table, in its order", () => {
  expect(Object.entries(criteriaFactors)).toEqual([
    ["unique", 1.2], ["in_person", 1.2], ["creative", 1.3], ["external_communication", 1.1], ["fixed_time", 1.1],
  ]);
  expect(criteriaKeys.filter(isCriterion)).toEqual(criteriaKeys);
  expect(["retired_criterion", "toString", "hours"].some(isCriterion)).toBe(false);
});

it("reads every criterion from a form, an unticked or absent one as false, and nothing else", () => {
  expect(criteriaFromValues({ in_person: "true", fixed_time: "true", creative: "false", retired_criterion: "true" }))
    .toEqual({ ...emptyCriteria(), in_person: true, fixed_time: true });
});
