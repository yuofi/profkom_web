// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { profileFeaturesApi } from "../../utils/api/profileFeatures.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { eventsApi } from "../../utils/api/events.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText, emptyCriteria } from "../../utils/api/contract";
import { UserProvider } from "../../utils/ctx";
import { ProfileEditPage } from "../ProfileEditPage/ProfileEditPage";
import { ProfilePage } from "../ProfilePage/ProfilePage";
import { ProfileSettingsPage } from "../ProfilePage/ProfileSettingsPage";
import { KkrTemplatesPage, SeasonsPage } from "./SeasonPages";
import { ProfileAchievements } from "../../components/Workspace/ProfileAchievements";
import { AssessmentPanel } from "../../components/Workspace/AssessmentPanel";
import { HistoryPanel } from "../../components/Workspace/HistoryPanel";
import { historyApi } from "../../utils/api/history.api";
vi.mock("../../assets/vk.svg?react", () => ({ default: () => null }));
vi.mock("../../assets/telegram.svg?react", () => ({ default: () => null }));
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks();vi.unstubAllGlobals(); });
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
async function api<T>(operation: () => Promise<T>) { let value!: T;await act(async () => { value = await operation(); });return value; }
async function season() {
  await liveLogin();const rows = (await seasonsApi.list()).items;
  const current = rows.find(row => row.state === "open");if (current) return current;
  const planned = rows.find(row => row.state === "planned") ?? await seasonsApi.create({ title: "Профиль и шаблоны HTTP", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 20 * 86400000).toISOString() });
  const opened = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });return "season" in opened ? opened.season : opened;
}

it("real profile editor keeps the preset local until one atomic profile save", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
  const actor = await liveParticipant("profile-editor-combined");
  const session = await liveLogin(actor.email);
  const before = await profileFeaturesApi.editor();
  page = await mountWorkspace(<UserProvider><ProfileEditPage /></UserProvider>, { session, path: "/profile/edit" });
  await waitForPage(page, () => !!button(page!.container, "Лист"));
  await act(async () => button(page!.container, "Лист").click());await waitForPage(page);
  expect((await api(profileFeaturesApi.editor)).contact.photo_url).toBe(before.contact.photo_url);
  await change(field(page.container, "name"), "ПрофильныйТест");
  await act(async () => button(page!.container, "Сохранить").click());await waitForPage(page);
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
  const saved = await api(profileFeaturesApi.editor);
  expect(saved.contact.name).toBe("ПрофильныйТест");expect(saved.contact.photo_url).toBe("/avatars/leaf.svg");expect(saved.revision).toBe(before.revision + 1);
  const prefs = await api(profileFeaturesApi.preferences);prefs.preferences.pgas.telegram = true;
  const updated = await api(() => profileFeaturesApi.savePreferences(prefs.revision, prefs.preferences));expect(updated.delivery_status).toBe("not_connected");expect(updated.preferences.pgas.telegram).toBe(true);
});

it("real repeated awards remain visible and revocation keeps its reason private", async () => {
  const recipient = await liveParticipant("profile-award-recipient"), stranger = await liveParticipant("profile-award-reader");
  const chair = await liveLogin();
  const context = await profileFeaturesApi.context(), global = context.award_scopes.find(scope => scope.kind === "global")!;
  const definition = await profileFeaturesApi.createAchievement({ title: "Повторная награда HTTP", description: "За фактический вклад", icon: "workspace_premium" }, global);
  const first = await profileFeaturesApi.grant(definition, recipient.user_id, "Приватное основание HTTP");
  await profileFeaturesApi.grant(definition, recipient.user_id, "Второй вклад");
  page = await mountWorkspace(<ProfileAchievements userId={recipient.user_id} />, { session: chair });await waitForPage(page);
  const badge = page.container.querySelector<HTMLButtonElement>(`button[data-achievement-grant="${first.grant_id}"]`)!;
  expect(badge.getAttribute("aria-label")).toContain("Повторная награда HTTP");
  await act(async () => badge.click());await waitForPage(page);
  const grantArticle = document.querySelector<HTMLElement>('[data-anchored-popover] article')!;
  expect(grantArticle.textContent).toContain("Приватное основание HTTP");
  await act(async () => grantArticle.querySelector("summary")!.click());
  await change(field(grantArticle, "reason"), "Приватная причина отзыва HTTP");await submit(grantArticle.querySelector("form")!);await waitForPage(page);
  const full = await api(() => profileFeaturesApi.achievements(recipient.user_id));
  expect(full.items.find(row => row.grant_id === first.grant_id)?.history.map(event => event.kind)).toEqual(["issued", "revoked"]);
  await page.cleanup();page = undefined;await liveLogin(stranger.email);
  const publicAwards = await profileFeaturesApi.achievements(recipient.user_id);
  expect(publicAwards.items.find(row => row.grant_id === first.grant_id)?.revoke_reason).toBeNull();
  expect(publicAwards.items.filter(row => !row.revoked_at)).toHaveLength(1);
});

it("real template fills the assessment draft and persists only with the normal KKR command", async () => {
  const worker = await liveParticipant("profile-template-worker");const active = await season();
  const event = await eventsApi.create({ season_id: active.season_id, title: "Шаблонное мероприятие HTTP", description: richText("") });
  let team = await eventsApi.createSubevent(event.event_id, { title: "Команда шаблонного оценивания", description: richText("") });
  team = await eventsApi.organizers(team.subevent_id, [worker.user_id], { expected_revision: team.revision });
  const task = await tasksApi.create({ season_id: active.season_id, scope: { kind: "subevent", id: team.subevent_id }, title: "Шаблонная оценка HTTP", description: richText("Сохранённое описание задачи"), deadline_at: new Date(Date.now() + 3600000).toISOString(), assignees: [{ user_id: worker.user_id, hours: 0 }] });
  await liveLogin(worker.email);const current = await tasksApi.get(task.task_id);await tasksApi.submitResult(task.task_id, { expected_revision: current.revision, text: richText("Фактический результат") });
  const session = await liveLogin();
  const template = await profileFeaturesApi.createTemplate({ visibility: "personal", values: { title: "Оценка по шаблону HTTP", description: "Назначение шаблона", hours: 4, evaluation: 1.5, criteria: emptyCriteria() } });
  page = await mountWorkspace(<AssessmentPanel assignment={task.assignments[0]} open hasResult />, { session });await waitForPage(page);
  await pick(page.container, "kkr-template", template.template_id);
  await act(async () => button(page!.container, "Подставить шаблон").click());await waitForPage(page);
  expect(field(page.container, "hours").value).toBe("4");expect((await api(() => tasksApi.assessment(task.assignments[0].assignment_id))).hours).toBe(0);
  await change(field(page.container, "reason"), "Применение сохранённого шаблона");
  const form = field(page.container, "hours").closest("form")!;await submit(form);await waitForPage(page);
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
  const saved = await api(() => tasksApi.assessment(task.assignments[0].assignment_id));expect(saved.hours).toBe(4);expect(saved.evaluation).toBe(1.5);
  expect((await api(() => tasksApi.get(task.task_id))).description.body).toBe("Сохранённое описание задачи");
  await api(() => profileFeaturesApi.updateTemplate(template, { ...template.values, hours: 40 }, false));
  expect((await api(() => tasksApi.assessment(task.assignments[0].assignment_id))).hours).toBe(4);
});

it("real history shows a public diff and explicit version hiding preserves current work and private KKR", async () => {
  const worker = await liveParticipant("history-version-worker"), active = await season();
  const event = await eventsApi.create({ season_id: active.season_id, title: "История HTTP", description: richText("") });
  let team = await eventsApi.createSubevent(event.event_id, { title: "Команда истории", description: richText("") });
  team = await eventsApi.organizers(team.subevent_id, [worker.user_id], { expected_revision: team.revision });
  const task = await tasksApi.create({ season_id: active.season_id, scope: { kind: "subevent", id: team.subevent_id }, title: "История версий HTTP", description: richText("Начальное описание"), deadline_at: new Date(Date.now() + 3600000).toISOString(), assignees: [{ user_id: worker.user_id, hours: 0 }] });
  const input = await tasksApi.assessment(task.assignments[0].assignment_id);
  const assessed = await tasksApi.updateAssessment(input.assignment_id, { expected_revision: input.revision, hours: 7, reason: "СЛУЖЕБНОЕ_ОСНОВАНИЕ_ККР" });
  const session = await liveLogin(worker.email);
  let edited = await tasksApi.update(task.task_id, { expected_revision: task.revision, description: richText("СКРЫВАЕМАЯ_ВЕРСИЯ_HTTP") });
  edited = await tasksApi.update(task.task_id, { expected_revision: edited.revision, description: richText("Сохранённое итоговое описание") });
  page = await mountWorkspace(<HistoryPanel kind="task" id={task.task_id} />, { session });await waitForPage(page);
  expect(page.container.textContent).not.toContain("СЛУЖЕБНОЕ_ОСНОВАНИЕ_ККР");
  const added = [...page.container.querySelectorAll<HTMLElement>('ins[data-change="added"]')].find(item => item.textContent === "СКРЫВАЕМАЯ_ВЕРСИЯ_HTTP")!;
  expect(added).toBeDefined();const row = added.closest("li")!;
  await act(async () => button(row, "Скрыть версию").click());
  expect(page.container.textContent).toContain("Текущие данные и ККР сохранятся");
  expect((await api(() => historyApi.list("task", task.task_id))).items.some(item => item.hidden)).toBe(false);
  await act(async () => button(row, "Подтвердить скрытие").click());await waitForPage(page);
  expect(page.container.textContent).toContain("Версия скрыта");expect(page.container.textContent).not.toContain("СКРЫВАЕМАЯ_ВЕРСИЯ_HTTP");
  expect((await api(() => tasksApi.get(task.task_id))).description.body).toBe(edited.description.body);
  await page.cleanup();page = undefined;await liveLogin();
  expect(await tasksApi.assessment(input.assignment_id)).toEqual(assessed);
});

it("real profile settings and KKR template library open separately from their overview pages", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
  const session = await liveLogin();
  page = await mountWorkspace(<UserProvider><Routes><Route path="/profile" element={<ProfilePage />} /><Route path="/profile/settings" element={<ProfileSettingsPage />} /></Routes></UserProvider>, { path: "/profile", session });await waitForPage(page);
  expect(page.container.textContent).not.toContain("Уведомления вне сайта");expect(page.container.textContent).not.toContain("Шаблоны ККР");
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/profile/settings"]')!.click());await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Настройки профиля");
  const checkbox = page.container.querySelector<HTMLInputElement>('input[aria-label="Новые документы ПГАС: VK"]')!;
  await act(async () => checkbox.click());const chosen = checkbox.checked;
  await submit(checkbox.closest("form")!);await waitForPage(page);
  expect((await api(profileFeaturesApi.preferences)).preferences.pgas.vk).toBe(chosen);
  await page.cleanup();page = undefined;
  page = await mountWorkspace(<Routes><Route path="/seasons" element={<SeasonsPage />} /><Route path="/seasons/templates" element={<KkrTemplatesPage />} /></Routes>, { path: "/seasons", session });await waitForPage(page);
  expect(page.container.querySelector("form")).toBeNull();
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/seasons/templates"]')!.click());await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Шаблоны ККР");expect(page.container.querySelector("form")).toBeNull();
  await act(async () => button(page!.container, "Создать шаблон ККР").click());expect(field(page.container, "title").value).toBe("");
});
