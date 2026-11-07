// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, pick, settle, submit, waitForPage } from "../../test/workspace";
import { MeritsPage } from "./MeritPages";
import { criteriaKeys, criteriaLabels } from "../../utils/kkrCriteria";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined; });
const label = (name: string) => field(page!.container, name).closest("div")!.querySelector("label")!.textContent;

it("marks the result date required for a positive evaluation, names the evaluations and lists recipients on the card", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const form = page.container.querySelector("form")!;
  // Dates, criteria and each recipient's values share rows instead of one tall column.
  expect(form.querySelector("fieldset")?.className).toMatch(/compactFields/);
  const userId = String(mock.state.people[0].user_id);
  await pick(page.container, "users", userId);
  expect([...field(page.container, `evaluation_${userId}`).querySelectorAll("option")].map(option => option.textContent)).toEqual(expect.arrayContaining(["Зачесть · оценка 1", "Не выполнено · оценка −1"]));
  expect(label(`completed_${userId}`)).not.toContain("*");
  await change(field(page.container, `evaluation_${userId}`), "1");
  expect(label(`completed_${userId}`)).toContain("*");
  await change(field(page.container, `evaluation_${userId}`), "0");
  expect(label(`completed_${userId}`)).not.toContain("*");
  for (const [name, value] of Object.entries({ title: "Помощь залу", body: "Работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", [`hours_${userId}`]: "3" })) await change(field(page.container, name), value);
  await submit(form);await waitForPage(page);
  const card = [...page.container.querySelectorAll("section")].find(section => section.querySelector("h2")?.textContent === "Помощь залу")!;
  const recipients = card.querySelector('ul[aria-label="Получатели"]')!;
  expect(recipients.querySelectorAll("li")).toHaveLength(1);
  expect(recipients.textContent).toContain("Анна");expect(recipients.textContent).toContain("3 ч · оценка 0");
});

it("ticks the five criteria as checkboxes named as on every other screen", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const form = page.container.querySelector("form")!;
  const boxes = criteriaKeys.map(key => form.querySelector<HTMLInputElement>(`input[type="checkbox"][name="${key}"]`)!);
  expect(boxes.map(box => box.closest("label")?.textContent)).toEqual(criteriaKeys.map(key => criteriaLabels[key]));
  expect(form.querySelector('select[name="creative"]')).toBeNull();
  const userId = String(mock.state.people[0].user_id);
  await pick(page.container, "users", userId);
  for (const [name, value] of Object.entries({ title: "Выезд", body: "Работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", [`hours_${userId}`]: "2", [`evaluation_${userId}`]: "0", creative: "true", in_person: "true" })) await change(field(page.container, name), value);
  expect(boxes.map(box => box.checked)).toEqual([false, true, false, true, false]);
  await submit(form);await waitForPage(page);
  const sent = JSON.parse(mock.adapter.history.post.find(request => request.url === "/merits")!.data);
  expect(sent.criteria).toEqual({ unique: false, creative: true, external_communication: false, in_person: true, fixed_time: false });
});
