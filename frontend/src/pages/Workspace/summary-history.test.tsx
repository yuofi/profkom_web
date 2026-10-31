// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import MockAdapter from "axios-mock-adapter";
import { act } from "react";
import { api } from "../../utils/api";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle, change } from "../../test/workspace";
import { SummaryHistory } from "./SummaryHistory";
import { invalidateWorkspace } from "../../utils/api/invalidation";
import type { SummaryVersionSnapshot } from "../../utils/api/contract";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let adapter: MockAdapter;
afterEach(async () => { await page?.cleanup(); page = undefined; adapter?.restore(); });
const first = (): SummaryVersionSnapshot => ({ version: 4, changed_by: createFixtures().user, changed_at: "2026-10-19T06:00:00Z", reason: "Первое утверждение", previous_summary_version: null,
  summary: { ...createFixtures("chair").summary, version: 4, state: "approved", capabilities: ["edit_decisions"] }, contributions: [], master_bonuses: [{ bonus_id: "unassigned", recipient_participant_id: null, amount: 0, basis: [], calculation_version: "master_bonus_v1" }] });

it("INT-03: historical rows remain read-only and are hidden when snapshot access is revoked", async () => {
  adapter = new MockAdapter(api);
  const snapshot = first();
  adapter.onGet('/seasons/season-1/summary/versions').reply(200, { items: [snapshot], next_cursor: null });
  adapter.onGet('/seasons/season-1/summary/versions/4').reply(200, snapshot);
  page = await mountWorkspace(<SummaryHistory seasonId="season-1" />, { role: "hr" });
  await settle(); await change(page.container.querySelector('select')!, '4'); await settle();
  expect(page.container.textContent).toContain('Первое утверждение');
  expect(page.container.textContent).toContain('Мастер не назначен');
  expect(page.container.querySelector('[aria-label="Историческая сводная"] form')).toBeNull();
  adapter.onGet('/seasons/season-1/summary/versions/4').reply(403, { detail: 'Access revoked' });
  await act(async () => invalidateWorkspace(page!.client)); await settle();
  expect(page.container.textContent).toContain('Access revoked');
  expect(page.container.querySelector('[aria-label="Историческая сводная"]')).toBeNull();
});

it("INT-03: an ordinary participant never requests calculated historical data", async () => {
  adapter = new MockAdapter(api);
  page = await mountWorkspace(<SummaryHistory seasonId="season-1" />, { role: "organizer" });
  await settle(); expect(adapter.history.get).toHaveLength(0); expect(page.container.textContent).toBe('');
});

it("formats the saved accruals and bonuses like the season pages, without formula versions", async () => {
  adapter = new MockAdapter(api);
  const snapshot = first(), row = snapshot.summary.rows[0];
  snapshot.contributions = [{ contribution_id: "c1", participant_id: row.participant_id, source_kind: "block_task", source_id: "task-1", source_title: "Афиша", score: 1.5, calculation_version: "assignment_v2" }];
  snapshot.master_bonuses = [{ ...snapshot.master_bonuses[0], recipient_participant_id: row.participant_id, amount: 2.25 }];
  adapter.onGet('/seasons/season-1/summary/versions').reply(200, { items: [snapshot], next_cursor: null });
  adapter.onGet('/seasons/season-1/summary/versions/4').reply(200, snapshot);
  page = await mountWorkspace(<SummaryHistory seasonId="season-1" />, { role: "hr" });
  await settle(); await change(page.container.querySelector('select')!, '4'); await settle();
  const text = page.container.querySelector('[aria-label="Историческая сводная"]')!.textContent;
  expect(text).toContain(`${row.user.display_name} · Афиша: 1,5`);
  expect(text).toContain(`${row.user.display_name}: 2,25 ККР`);
  expect(text).not.toMatch(/Формула|assignment_v2|master_bonus_v1|1\.50|2\.25/);
});
