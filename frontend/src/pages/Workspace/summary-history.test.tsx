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
  summary: { ...createFixtures("chair").summary, version: 4, state: "approved", capabilities: ["edit_decisions"] }, contributions: [], master_bonuses: [] });

it("INT-03: historical rows remain read-only and are hidden when snapshot access is revoked", async () => {
  adapter = new MockAdapter(api);
  const snapshot = first();
  adapter.onGet('/seasons/season-1/summary/versions').reply(200, { items: [snapshot], next_cursor: null });
  adapter.onGet('/seasons/season-1/summary/versions/4').reply(200, snapshot);
  page = await mountWorkspace(<SummaryHistory seasonId="season-1" />, { role: "hr" });
  await settle(); await change(page.container.querySelector('select')!, '4'); await settle();
  expect(page.container.textContent).toContain('Первое утверждение');
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
