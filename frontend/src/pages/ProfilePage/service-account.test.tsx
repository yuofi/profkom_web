// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { UserProvider } from "../../utils/ctx";
import { ProfilePage } from "./ProfilePage";
import { ProfileEditPage } from "../ProfileEditPage/ProfileEditPage";

// The unit config has no SVG components plugin; the icons do not matter here.
vi.mock("../../assets/vk.svg?react", () => ({ default: () => null }));
vi.mock("../../assets/telegram.svg?react", () => ({ default: () => null }));

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
// jsdom has no media queries; the profile card asks for the phone layout.
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({
  matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent: () => false,
})));
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.unstubAllGlobals(); });

const PERSON_CARDS = ["Текущие команды", "Достижения", "Участие и деятельность"];
// The server answers these only about a person: 403/404 about the service account.
const personReads = () => mock!.adapter.history.get.filter(request =>
  /^\/participants\/\d+\/participation$|^\/profiles\/\d+\/(activity|achievements)$/.test(request.url ?? "")
  || (request.url === "/achievements" && request.params?.recipient_user_id !== undefined));
const headings = () => [...page!.container.querySelectorAll("h2")].map(node => node.textContent);
const links = () => [...page!.container.querySelectorAll("a")].map(node => node.textContent);

async function openProfile(service: boolean) {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.session.service_account = service;
  page = await mountWorkspace(<UserProvider><ProfilePage /></UserProvider>, { role: "chair", path: "/profile" });
  await waitForPage(page, () => !!page!.container.querySelector("h1"));
}

it("a person's own profile shows their teams, achievements and activity", async () => {
  await openProfile(false);
  expect(headings()).toEqual(expect.arrayContaining(PERSON_CARDS));
  expect(links()).toContain("Редактировать свои данные");
  expect(personReads().length).toBeGreaterThan(0);
});

it("the service account's own profile asks for no person card and offers no editor (owner 2026-11-08)", async () => {
  await openProfile(true);
  for (const title of PERSON_CARDS) expect(headings()).not.toContain(title);
  expect(personReads()).toEqual([]);
  expect(page!.container.textContent).toContain("Сервисный аккаунт не участвует в работе Профкома");
  expect(page!.container.querySelector('[role="alert"]')).toBeNull();
  expect(links()).not.toContain("Редактировать свои данные");
  expect(links()).toContain("Мои обращения");
});

it("the editor tells the service account its data is the server's and shows no form", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.session.service_account = true;
  page = await mountWorkspace(<UserProvider><ProfileEditPage /></UserProvider>, { role: "chair", path: "/profile/edit" });
  await waitForPage(page, () => !!page!.container.querySelector("h1"));
  expect(page.container.textContent).toContain("Данные сервисного аккаунта задаёт сервер");
  expect(page.container.querySelector("form")).toBeNull();
  expect(mock.adapter.history.get.filter(request => request.url === "/profile/me/editor")).toEqual([]);
});
