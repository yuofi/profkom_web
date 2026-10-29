// @vitest-environment jsdom
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { SessionContext } from "../../utils/session";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { forgetOwnChanges } from "../../components/Workspace/ownRevisions";
import { change, field, pick, submit, waitForPage } from "../../test/workspace";
import { SeasonPage } from "./SeasonPages";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.();cleanup = undefined;vi.restoreAllMocks(); });

function largeSummary(): SeasonSummary {
  const summary = structuredClone(createFixtures("chair").summary), source = summary.rows[0];
  summary.rows = Array.from({ length: 100 }, (_, index): SummaryRow => ({
    ...structuredClone(source), participant_id: `participant-${9000 + index}`,
    user: { user_id: 9000 + index, display_name: `Синтетический участник ${index.toString().padStart(3, "0")}`, avatar_url: null },
    group_number: index % 2 ? "201" : "301", category: index % 2 ? "junior" : "activist",
    blocks: [{ block_id: index % 2 ? "block-info" : "block-it", name: index % 2 ? "Инфо" : "IT" }],
    is_master: false, is_archived: false, decisions: [], previous_decisions: [], rank: index + 1,
  }));
  return summary;
}

async function mountParticipants(otherEditor = false, renderBudget = 200) {
  const transport = installMockTransport("chair", { delay: 0 });
  const summary = largeSummary(), read = vi.spyOn(seasonsApi, "summary").mockImplementation(async () => structuredClone(summary));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container);
  let commits = 0;
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider>{otherEditor && <ActionForm fields={[{ name: "other_draft", label: "Другой редактор" }]} onSubmit={async () => {}} />}<Outlet /></UnsavedChangesProvider>, errorElement: <p data-render-limit>Unexpected render failure</p>, children: [
    { path: "/seasons/:id", element: <Profiler id="large-season" onRender={() => { if (++commits > renderBudget) throw Error("Season exceeded the bounded render budget"); }}><SeasonPage /></Profiler> },
    { path: "/elsewhere", element: <p>Другая страница</p> },
  ] }], { initialEntries: ["/seasons/season-1?tab=participants"] });
  cleanup = async () => { await act(async () => root.unmount());router.dispose();client.clear();forgetOwnChanges(client);container.remove();transport.restore(); };
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: transport.state.session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  const page = { client, container };await waitForPage(page, () => !!container.querySelector("tbody"));
  return { ...page, router, read, summary, transport, commits: () => commits };
}

function rowFor(container: HTMLElement, label: string) {
  const row = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")].find(row => row.textContent?.includes(label));
  expect(row, label).toBeDefined();return row!;
}
async function openDecision(page: Awaited<ReturnType<typeof mountParticipants>>, label = "Синтетический участник 000") {
  const row = rowFor(page.container, label), disclosure = row.querySelector("details")!;
  if (!disclosure.open) await act(async () => disclosure.querySelector("summary")!.click());await waitForPage(page, () => !!row.querySelector('input[name="reason"]'));
  return { row, disclosure, form: row.querySelector("form")! };
}
function dialogButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find(button => button.textContent === label);expect(button, label).toBeDefined();return button!;
}

it("keeps a hundred-row season responsive while filtering and ticking one decision without a request or render loop", async () => {
  const page = await mountParticipants();expect(page.container.querySelectorAll("tbody tr")).toHaveLength(100);
  await change(field(page.container, "category"), "junior");await waitForPage(page);expect(page.container.querySelectorAll("tbody tr")).toHaveLength(50);
  await change(field(page.container, "category"), "");await waitForPage(page);
  const { row } = await openDecision(page);
  await pick(row, "decisions", "nice");await change(field(row, "reason"), "Синтетическая проверка отметки");await waitForPage(page);
  expect(row.querySelector<HTMLInputElement>('input[name="decisions"][value="nice"]')?.checked).toBe(true);
  expect(page.read).toHaveBeenCalledTimes(1);expect(page.transport.adapter.history.put).toHaveLength(0);
  expect(page.commits()).toBeLessThan(200);expect(page.container.querySelector("[data-render-limit]")).toBeNull();
});

it("retains a dirty decision when a participant filter would hide its row", async () => {
  const page = await mountParticipants();let { row } = await openDecision(page);
  await pick(row, "decisions", "nice");await change(field(row, "reason"), "Несохранённое основание");
  await change(field(page.container, "category"), "junior");await waitForPage(page);
  // A local filter must either keep the editor alive or request an explicit
  // discard. Changing the filter back may never silently erase its draft.
  const confirmation = [...page.container.querySelectorAll("dialog")].find(dialog => dialog.textContent?.includes("Есть несохранённые изменения"));
  if (confirmation) {
    const stay = [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Остаться");
    expect(stay).toBeDefined();await act(async () => stay!.click());await waitForPage(page);
    expect(field(page.container, "category").value).toBe("");
  } else {
    await change(field(page.container, "category"), "");await waitForPage(page);
  }
  row = rowFor(page.container, "Синтетический участник 000");
  expect(field(row, "reason").value).toBe("Несохранённое основание");
  expect(row.querySelector<HTMLInputElement>('input[name="decisions"][value="nice"]')?.checked).toBe(true);
});

it("keeps the only dirty editor open on cancelled close and retains it through stable-row sorting", async () => {
  const page = await mountParticipants();expect(page.container.querySelectorAll("tbody form")).toHaveLength(0);
  const { row, disclosure, form } = await openDecision(page);expect(page.container.querySelectorAll("tbody form")).toHaveLength(1);
  await pick(row, "decisions", "nice");await change(field(form, "reason"), "Черновик свёрнутого редактора");
  await act(async () => disclosure.querySelector("summary")!.click());await waitForPage(page);
  expect(disclosure.open).toBe(true);expect(page.container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");
  await act(async () => dialogButton(page.container, "Остаться").click());await waitForPage(page);
  expect(form.isConnected).toBe(true);expect(field(form, "reason").value).toBe("Черновик свёрнутого редактора");
  await change(page.container.querySelector<HTMLSelectElement>('select[aria-label="Порядок"]')!, "score-asc");await waitForPage(page);
  expect(page.container.querySelector("dialog")).toBeNull();expect(form.isConnected).toBe(true);
  expect(field(form, "reason").value).toBe("Черновик свёрнутого редактора");expect(page.container.querySelectorAll("tbody form")).toHaveLength(1);
});

it.each(["search", "block", "category", "master", "archived", "marks"] as const)("guards the %s filter while a decision is dirty and keeps its old value on stay", async filter => {
  const page = await mountParticipants(), { row, form } = await openDecision(page);
  await pick(row, "decisions", "nice");await change(field(form, "reason"), "Не терять основание отметки");
  const input = filter === "search" ? page.container.querySelector<HTMLInputElement>('input[placeholder="Имя или группа"]')! : field(page.container, ({ block: "block", category: "category", master: "is_master", archived: "is_archived", marks: "marks" } as const)[filter]);
  const next = { search: "участник 099", block: "block-info", category: "junior", master: "true", archived: "true", marks: "any" }[filter];
  await change(input, next);await waitForPage(page);expect(page.container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");
  await act(async () => dialogButton(page.container, "Остаться").click());await waitForPage(page);
  expect(input.value).toBe("");expect(form.isConnected).toBe(true);expect(field(form, "reason").value).toBe("Не терять основание отметки");
  expect(page.transport.adapter.history.put).toHaveLength(0);expect(page.commits()).toBeLessThan(200);
});

it("applies a filter only after explicitly discarding that season's decision draft", async () => {
  const page = await mountParticipants(), { row, form } = await openDecision(page);
  await pick(row, "decisions", "nice");await change(field(form, "reason"), "Будет явно отброшено");
  await change(field(page.container, "category"), "junior");await waitForPage(page);
  await act(async () => dialogButton(page.container, "Уйти без сохранения").click());await waitForPage(page);
  expect(field(page.container, "category").value).toBe("junior");expect(page.container.querySelectorAll("tbody tr")).toHaveLength(50);expect(form.isConnected).toBe(false);
  expect(page.transport.adapter.history.put).toHaveLength(0);await change(field(page.container, "category"), "");await waitForPage(page);
  expect(page.container.querySelectorAll("tbody form")).toHaveLength(0);
  const again = await openDecision(page);expect(field(again.form, "reason").value).toBe("");expect(again.form.querySelector<HTMLInputElement>('input[value="nice"]')?.checked).toBe(false);
});

it("saves the decision with the captured summary version before applying a filter", async () => {
  const page = await mountParticipants(), { row, form } = await openDecision(page);
  const save = vi.spyOn(seasonsApi, "decisions").mockImplementation(async (seasonId, userId, values) => {
    expect(seasonId).toBe("season-1");expect(userId).toBe(9000);expect(values.expected_version).toBe(1);
    page.summary.rows[0].decisions = values.decisions;page.summary.version = 2;return structuredClone(page.summary);
  });
  await pick(row, "decisions", "nice");await change(field(form, "reason"), "Подтверждённое основание");
  await change(field(page.container, "category"), "junior");await waitForPage(page);
  await act(async () => dialogButton(page.container, "Сохранить и перейти").click());await waitForPage(page);
  expect(save).toHaveBeenCalledExactlyOnceWith("season-1", 9000, { expected_version: 1, decisions: ["nice"], reason: "Подтверждённое основание" });
  expect(field(page.container, "category").value).toBe("junior");expect(page.container.querySelector("dialog")).toBeNull();expect(page.summary.version).toBe(2);
});

it("does not apply the filter or discard the draft when save-on-leave validation fails", async () => {
  const page = await mountParticipants(), { row, form } = await openDecision(page), save = vi.spyOn(seasonsApi, "decisions");
  await pick(row, "decisions", "nice");await change(field(page.container, "category"), "junior");await waitForPage(page);
  await act(async () => dialogButton(page.container, "Сохранить и перейти").click());await waitForPage(page);
  expect(save).not.toHaveBeenCalled();expect(field(page.container, "category").value).toBe("");expect(form.isConnected).toBe(true);
  expect(page.container.querySelector("dialog")?.textContent).toContain("Изменения не сохранены");expect(form.querySelector<HTMLInputElement>('input[value="nice"]')?.checked).toBe(true);
});

it("protects only the participant editor scope while unrelated drafts survive filtering", async () => {
  const page = await mountParticipants(true);await change(field(page.container, "other_draft"), "Чужой черновик остаётся");
  await change(field(page.container, "category"), "junior");await waitForPage(page);
  expect(page.container.querySelector("dialog")).toBeNull();expect(field(page.container, "category").value).toBe("junior");
  expect(field(page.container, "other_draft").value).toBe("Чужой черновик остаётся");
});

it("saves the first draft before switching to the next editor and uses the refreshed summary version", async () => {
  const page = await mountParticipants(), first = await openDecision(page);
  const save = vi.spyOn(seasonsApi, "decisions").mockImplementation(async (_seasonId, userId, values) => {
    expect(values.expected_version).toBe(page.summary.version);page.summary.rows.find(row => row.user.user_id === userId)!.decisions = values.decisions;
    page.summary.version++;return structuredClone(page.summary);
  });
  await pick(first.row, "decisions", "nice");await change(field(first.form, "reason"), "Первая отметка");
  const nextRow = rowFor(page.container, "Синтетический участник 001");
  await act(async () => nextRow.querySelector("summary")!.click());await waitForPage(page);
  await act(async () => dialogButton(page.container, "Остаться").click());await waitForPage(page);
  expect(first.form.isConnected).toBe(true);expect(nextRow.querySelector("form")).toBeNull();expect(field(first.form, "reason").value).toBe("Первая отметка");
  await act(async () => nextRow.querySelector("summary")!.click());await waitForPage(page);
  await act(async () => dialogButton(page.container, "Сохранить и перейти").click());await waitForPage(page, () => !!nextRow.querySelector("form"));
  const second = { row: nextRow, form: nextRow.querySelector("form")! };expect(first.form.isConnected).toBe(false);expect(page.container.querySelectorAll("tbody form")).toHaveLength(1);
  await pick(second.row, "decisions", "kick_warning");await change(field(second.form, "reason"), "Вторая отметка");
  await submit(second.form);await waitForPage(page);expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls.map(([, userId, values]) => ({ userId, version: values.expected_version }))).toEqual([{ userId: 9000, version: 1 }, { userId: 9001, version: 2 }]);
  expect(page.summary.version).toBe(3);expect(page.summary.rows[0].decisions).toEqual(["nice"]);expect(page.summary.rows[1].decisions).toEqual(["kick_warning"]);
  expect(page.container.querySelectorAll("tbody form")).toHaveLength(1);
});

it("visits a hundred decision disclosures without accumulating hidden forms", async () => {
  const page = await mountParticipants(false, 1000);expect(page.container.querySelectorAll("tbody form")).toHaveLength(0);
  for (let index = 0; index < 100; index++) {
    const { disclosure } = await openDecision(page, `Синтетический участник ${index.toString().padStart(3, "0")}`);
    expect(disclosure.open).toBe(true);expect(page.container.querySelectorAll("tbody form")).toHaveLength(1);
    expect(page.container.querySelectorAll("tbody details[open]")).toHaveLength(1);
  }
  const last = rowFor(page.container, "Синтетический участник 099");await act(async () => last.querySelector("summary")!.click());await waitForPage(page);
  expect(page.container.querySelectorAll("tbody form")).toHaveLength(0);expect(page.container.querySelectorAll("tbody details[open]")).toHaveLength(0);
  expect(page.container.querySelector("dialog")).toBeNull();expect(page.commits()).toBeLessThan(1000);expect(page.read).toHaveBeenCalledTimes(1);
}, 15000);

it("discards a draft only after explicit confirmation when switching to another participant", async () => {
  const page = await mountParticipants(), first = await openDecision(page), save = vi.spyOn(seasonsApi, "decisions");
  await pick(first.row, "decisions", "nice");await change(field(first.form, "reason"), "Явно отбрасываемый черновик");
  const next = rowFor(page.container, "Синтетический участник 001");await act(async () => next.querySelector("summary")!.click());await waitForPage(page);
  expect(first.form.isConnected).toBe(true);await act(async () => dialogButton(page.container, "Уйти без сохранения").click());await waitForPage(page);
  expect(first.form.isConnected).toBe(false);expect(next.querySelector("form")).not.toBeNull();expect(save).not.toHaveBeenCalled();
  await openDecision(page);expect(field(first.row, "reason").value).toBe("");expect(first.row.querySelector<HTMLInputElement>('input[value="nice"]')?.checked).toBe(false);
});

it("closes a clean editor and reopens with the current server values and version", async () => {
  const page = await mountParticipants(), first = await openDecision(page);
  await act(async () => first.disclosure.querySelector("summary")!.click());await waitForPage(page);expect(first.form.isConnected).toBe(false);
  page.summary.rows[0].decisions = ["kick"];page.summary.version = 7;
  await act(async () => { await page.client.invalidateQueries({ queryKey: ["summary", "season-1"] }); });await waitForPage(page);
  const reopened = await openDecision(page);expect(reopened.form.querySelector<HTMLInputElement>('input[value="kick"]')?.checked).toBe(true);
  const save = vi.spyOn(seasonsApi, "decisions").mockImplementation(async (_id, _userId, values) => { expect(values.expected_version).toBe(7);page.summary.version = 8;return structuredClone(page.summary); });
  await change(field(reopened.form, "reason"), "Подтверждаем актуальные отметки");await submit(reopened.form);await waitForPage(page);
  expect(save).toHaveBeenCalledExactlyOnceWith("season-1", 9000, { expected_version: 7, decisions: ["kick"], reason: "Подтверждаем актуальные отметки" });
});
