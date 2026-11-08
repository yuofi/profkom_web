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

/** The criteria of a form whose checkbox fields are named by their keys ("true" / "false"). */
export const criteriaFromValues = (values: Record<string, string | string[] | undefined>): Criteria =>
  Object.fromEntries(criteriaKeys.map((key) => [key, values[key] === "true"])) as unknown as Criteria;
