// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { richText } from "../../utils/api/contract";
import { reportsApi } from "../../utils/api/reports.api";
import { ReportPage } from "./ReportPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

it("edits a report draft as title, Markdown text and attachments in one form with one row of actions (EV-15)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const report = mock.state.reports[0];
  page = await mountWorkspace(<Routes><Route path="/reports/:id" element={<ReportPage />} /></Routes>, { path: `/reports/${report.report_id}` });
  await waitForPage(page, () => !!page!.container.querySelector('[name="body"]'));
  const form = field(page.container, "body").closest("form")!;
  // Reading order: title, text with its formatting toolbar, then attachments behind the site's button.
  const order = [field(form, "title"), field(form, "body"), form.querySelector('input[type="file"]')!];
  expect(order.every((node, index) => !index || order[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  expect(form.querySelector('[role="toolbar"][aria-label="Форматирование Markdown"]')).not.toBeNull();
  expect(form.querySelector('input[type="file"]')!.closest("label")?.textContent).toContain("Прикрепить файлы");
  // Save and the preview toggle share one row; publishing stays its own form.
  const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!, toggle = [...form.querySelectorAll("button")].find(button => button.textContent === "Предпросмотр сохранённого черновика")!;
  expect(save.parentElement).toBe(toggle.parentElement);
  expect(save.parentElement!.className).toContain("row");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  const publish = [...page.container.querySelectorAll("button")].find(button => button.textContent === "Опубликовать сохранённый отчёт");
  expect(publish?.closest("form")).toBeTruthy();
  expect(publish!.closest("form")).not.toBe(form);
  // The Markdown text is a form value: it is saved with the draft's revision.
  const update = vi.spyOn(reportsApi, "update"), revision = report.revision;
  await change(field(form, "body"), "Новый **текст**");await submit(form);
  expect(update).toHaveBeenCalledWith(report.report_id, expect.objectContaining({ expected_revision: revision, content: richText("Новый **текст**") }));
});
