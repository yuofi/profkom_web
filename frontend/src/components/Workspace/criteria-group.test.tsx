// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Route, Routes } from "react-router-dom";
import { getAllByRole, getByRole } from "@testing-library/dom";
import { afterEach, expect, it, vi } from "vitest";
import { CriteriaGroup } from "./CriteriaGroup";
import { KkrTemplateLibrary } from "./KkrTemplateLibrary";
import { UnifiedKkrEditor } from "./UnifiedKkrEditor";
import { CorrectionsPage, MeritsPage } from "../../pages/Workspace/MeritPages";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, pick, settle, submit, waitForPage } from "../../test/workspace";
import { emptyCriteria, richText, type Criteria } from "../../utils/api/contract";
import { kkrApi } from "../../utils/api/kkr.api";
import { profileFeaturesApi, type KkrTemplate } from "../../utils/api/profileFeatures.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { criteriaKeys, criteriaLabels } from "../../utils/kkrCriteria";

// Owner A1, variant Б: the five criteria as equal tiles, one component on all four screens.
let page: { container: HTMLElement; cleanup: () => Promise<void> } | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });

/** The multipliers of the owner's table, in its order, as the tiles print them. */
const factors = ["×1,2", "×1,2", "×1,3", "×1,1", "×1,1"];

/** The tiles of the group with this legend: the five boxes in the table's order, each named by its
 *  criterion alone and described by its multiplier. */
function tiles(scope: HTMLElement, legend: string) {
  const group = getByRole(scope, "group", { name: legend });
  expect(group.tagName).toBe("FIELDSET");
  const boxes = getAllByRole(group, "checkbox") as HTMLInputElement[];
  expect(boxes.map(box => box.name)).toEqual(criteriaKeys);
  criteriaKeys.forEach((key, index) => expect(getByRole(group, "checkbox", { name: criteriaLabels[key], description: factors[index] })).toBe(boxes[index]));
  return { group, boxes, tile: (key: keyof Criteria) => boxes[criteriaKeys.indexOf(key)].closest("label")! };
}
async function click(element: HTMLElement) { await act(async () => element.click()); }

async function mountGroup(props: Partial<Parameters<typeof CriteriaGroup>[0]> = {}) {
  const changes: [keyof Criteria, boolean][] = [];
  function Harness() {
    const [value, setValue] = useState<Criteria>(emptyCriteria());
    return <CriteriaGroup checked={key => value[key]} onChange={(key, on) => { changes.push([key, on]);setValue(old => ({ ...old, [key]: on })); }} {...props} />;
  }
  const container = document.createElement("div");document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  page = { container, cleanup: async () => { await act(async () => root.unmount());container.remove(); } };
  return { container, changes };
}

it("draws the five criteria as tiles in the table's order: a real checkbox each, named by its criterion, its multiplier beside", async () => {
  const { container } = await mountGroup({ legend: "Общие признаки задачи" });
  const { group, boxes, tile } = tiles(container, "Общие признаки задачи");
  expect(group.querySelector("legend")?.textContent).toBe("Общие признаки задачи");
  expect(boxes.every(box => box.type === "checkbox" && !box.checked)).toBe(true);
  // The tile is the box's label: the multiplier and the name are printed in it, the name in the table's words.
  expect(criteriaKeys.map(key => tile(key).textContent)).toEqual(criteriaKeys.map((key, index) => `${factors[index]}${criteriaLabels[key]}`));
  expect(new Set(criteriaKeys.map(key => tile(key).className)).size).toBe(1);
});

it("names the group «Признаки задачи» unless a screen gives its own legend", async () => {
  const { container } = await mountGroup();
  tiles(container, "Признаки задачи");
});

it("ticks and unticks a criterion by a click anywhere on its tile", async () => {
  const { container, changes } = await mountGroup();
  const { boxes, tile } = tiles(container, "Признаки задачи");
  await click(tile("creative"));
  expect(boxes.map(box => box.checked)).toEqual(criteriaKeys.map(key => key === "creative"));
  // On the multiplier or on the name: still the same tile.
  await click(document.getElementById(boxes[2].getAttribute("aria-describedby")!)!);
  await click(document.getElementById(boxes[4].getAttribute("aria-labelledby")!)!);
  expect(boxes.map(box => box.checked)).toEqual(criteriaKeys.map(key => key === "fixed_time"));
  expect(changes).toEqual([["creative", true], ["creative", false], ["fixed_time", true]]);
});

it("locks every tile of a disabled group", async () => {
  const { container, changes } = await mountGroup({ disabled: true });
  const { group, boxes, tile } = tiles(container, "Признаки задачи");
  expect((group as HTMLFieldSetElement).disabled).toBe(true);
  expect(boxes.every(box => box.matches(":disabled"))).toBe(true);
  await click(tile("unique"));
  expect(boxes[0].checked).toBe(false);expect(changes).toEqual([]);
});

it("the KKR window draws the shared tiles and saves the same five criteria keys", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const task = mock.state.tasks[0];task.status = "closed";task.closed_at = "2026-10-30T02:00:00Z";
  const save = vi.spyOn(kkrApi, "saveBatch").mockImplementation(async (id, data) => ({ ...(await kkrApi.batch(id)), criteria: data.criteria }));
  const mounted = await mountWorkspace(<UnifiedKkrEditor task={task} />);page = mounted;
  await waitForPage(mounted, () => !!mounted.container.querySelector('[role="radiogroup"]'));
  const { boxes, tile } = tiles(mounted.container, "Общие признаки задачи");
  const before = boxes.map(box => box.checked);
  await click(tile("external_communication"));
  expect(boxes.map(box => box.checked)).toEqual(criteriaKeys.map((key, index) => key === "external_communication" ? !before[index] : before[index]));
  await submit(mounted.container.querySelector("form")!);await waitForPage(mounted);
  expect(save).toHaveBeenCalledTimes(1);
  const sent = save.mock.calls[0][1].criteria;
  expect(Object.keys(sent)).toEqual(criteriaKeys);
  expect(Object.values(sent)).toEqual(boxes.map(box => box.checked));
});

it("the merit form draws the shared tiles and a tile ticks its criterion", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const mounted = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });page = mounted;
  await waitForPage(mounted);await settle();
  const form = mounted.container.querySelector("form")!;
  const { tile } = tiles(form, "Признаки задачи");
  // One group in place of the five separate checkbox fields.
  expect(form.querySelectorAll('input[type="checkbox"][name="unique"]')).toHaveLength(1);
  await click(tile("in_person"));
  expect(field(form, "in_person")).toHaveProperty("checked", true);
});

it.each(["task_inputs", "merit"])("the correction of closed results (%s) draws the shared tiles with the saved criteria", async kind => {
  mock = installMockTransport("chair", { delay: 0 });
  const merit = await seasonsApi.createMerit({ season_id: "season-1", source_kind: "block_volunteer", scope: { kind: "block", id: "info" }, title: "Волонтёрская работа",
    description: richText("Описание"), assigned_at: "2026-10-01T10:00:00Z", deadline_at: "2026-10-10T10:00:00Z", criteria: { ...emptyCriteria(), in_person: true },
    recipients: [{ user_id: 101, hours: 2, evaluation: 1, completed_at: "2026-10-02T10:00:00Z" }], reason: "Работа учтена" });
  mock.state.seasons.find(season => season.season_id === "season-1")!.state = "closed";
  const mounted = await mountWorkspace(<Routes><Route path="/seasons/:id/corrections" element={<CorrectionsPage />} /></Routes>, { path: "/seasons/season-1/corrections" });page = mounted;
  await settle();await settle();
  await change(mounted.container.querySelector("select")!, kind);
  await pick(mounted.container, "correction_object", kind === "merit" ? merit.merit_id : mock.state.tasks[0].task_id);await settle();
  const { boxes, tile } = tiles(mounted.container.querySelector("form")!, "Признаки задачи");
  const saved = kind === "merit" ? merit.criteria : mock.state.inputs.criteria;
  expect(boxes.map(box => box.checked)).toEqual(criteriaKeys.map(key => saved[key]));
  await click(tile("unique"));
  expect(boxes[0].checked).toBe(!saved.unique);
});

it("the template editor draws the shared tiles and saves the ticked criteria", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const author = { user_id: 101, display_name: "Анна Смирнова", avatar_url: null };
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [] });
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue({ award_scopes: [], award_icons: [], can_create_personal_template: true, template_scopes: [] });
  const create = vi.spyOn(profileFeaturesApi, "createTemplate").mockImplementation(async data => (
    { template_id: "new", visibility: "personal", scope: null, revision: 1, archived: false, values: data.values, author, updated_by: author } satisfies KkrTemplate));
  const mounted = await mountWorkspace(<KkrTemplateLibrary embedded />);page = mounted;
  await waitForPage(mounted);
  await click([...mounted.container.querySelectorAll("button")].find(button => button.textContent === "Создать шаблон ККР")!);await waitForPage(mounted);
  const editor = mounted.container.querySelector<HTMLElement>('section[aria-label="Новый шаблон ККР"]')!;
  const { tile } = tiles(editor, "Признаки задачи");
  await click(tile("unique"));await click(tile("fixed_time"));
  await change(field(editor, "title"), "Дежурство у входа");await change(field(editor, "hours"), "2");
  await submit(editor.querySelector("form")!);await waitForPage(mounted);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0].values.criteria).toEqual({ ...emptyCriteria(), unique: true, fixed_time: true });
  expect(Object.keys(create.mock.calls[0][0].values.criteria)).toEqual(criteriaKeys);
});
