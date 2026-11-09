import type { Criteria } from "./api/contract";

/**
 * The five KKR criteria in order, named as in the owner's KKR table (2026-11-08). Every screen
 * that names a criterion reads this list; the server's formula, export and history use the same
 * table (backend database.KKR_CRITERIA_TABLE, whose test compares these labels).
 */
export const criteriaLabels: Record<keyof Criteria, string> = {
  unique: "Задача уникальная",
  in_person: "Требует очного присутствия",
  creative: "Задача требует творческого подхода",
  external_communication: "Требует общения с администрацией или людьми вне вуза",
  fixed_time: "Выполняется в определённое время",
};
export const criteriaKeys = Object.keys(criteriaLabels) as (keyof Criteria)[];
/** The multiplier of each criterion, as in the owner's table and backend KKR_CRITERIA_TABLE (tests/test_kkr_criteria.py compares them). */
export const criteriaFactors: Record<keyof Criteria, number> = {
  unique: 1.2,
  in_person: 1.2,
  creative: 1.3,
  external_communication: 1.1,
  fixed_time: 1.1,
};
/** A form field or key that names one of the five criteria. */
export const isCriterion = (name: string): name is keyof Criteria => Object.hasOwn(criteriaLabels, name);

/** The criteria of a form whose checkbox fields are named by their keys ("true" / "false"). */
export const criteriaFromValues = (values: Record<string, string | string[] | undefined>): Criteria =>
  Object.fromEntries(criteriaKeys.map((key) => [key, values[key] === "true"])) as unknown as Criteria;
