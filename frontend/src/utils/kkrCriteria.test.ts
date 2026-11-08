import { expect, it } from "vitest";
import { emptyCriteria } from "./api/contract";
import { criteriaFromValues, criteriaKeys, criteriaLabels } from "./kkrCriteria";

it("names the eight criteria of the owner's table in its order and wording (2026-11-08)", () => {
  expect(Object.entries(criteriaLabels)).toEqual([
    ["urgent", "Срочная задача"],
    ["unique", "Задача уникальная"],
    ["monotonous", "Нудная / монотонная задача"],
    ["creative", "Задача требует творческого подхода"],
    ["external_communication", "Требует общения с администрацией или людьми вне вуза"],
    ["physical", "Требуется ли физическая сила"],
    ["in_person", "Требует очного присутствия"],
    ["fixed_time", "Выполняется в определённое время"],
  ]);
  expect(Object.keys(emptyCriteria())).toEqual(criteriaKeys);
});

it("reads every criterion from a form, an unticked or absent one as false", () => {
  expect(criteriaFromValues({ urgent: "true", physical: "true", creative: "false" })).toEqual({ ...emptyCriteria(), urgent: true, physical: true });
});
