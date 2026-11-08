// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { membershipApi } from "../../utils/api/membership.api";
import { richText } from "../../utils/api/contract";
import { BlockPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
// A card's title is its own heading or the heading of its first row (with the card's button).
const card = (title: string) => [...page!.container.querySelectorAll("section")].find(section => section.querySelector(":scope > h2, :scope > div > h2")?.textContent === title);
const nav = () => page!.container.querySelector('header [role="group"][aria-label="Действия блока"]')!;
const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map(item => item.textContent);
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text || item.getAttribute("aria-label") === text);
async function openBlock(role: "chair" | "organizer" = "chair", blockId = "block-info") {
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${blockId}`, role });await waitForPage(page);
  return mock!.state.blocks.find(block => block.block_id === blockId)!;
}

it("puts the block's actions in one row under its name, the avatar and «Все блоки» at the side (D-05)", async () => {
  mock = installMockTransport("chair", { delay: 0 });await openBlock();
  const header = page!.container.querySelector("header")!;
  expect(nav().closest("header > div")).toBe(header.firstElementChild);
  expect(nav().previousElementSibling?.tagName).toBe("H1");
  expect(texts(nav(), "a")).toEqual(["Задачи блока", "Учесть волонтёрскую работу", "Гайд блока", "Сообщество блока"]);
  // The chair is not in this block: the application is the last action of the row.
  expect(nav().lastElementChild?.tagName).toBe("FORM");expect(button(nav(), "Подать заявку в блок")).toBeDefined();
  expect(texts(header.querySelector('[class*="blockHeaderActions"]')!, "a")).toEqual(["Все блоки"]);
  // No card holds only buttons any more: the first card is the description.
  expect(texts(page!.container, "section > h2, section > div > h2")).toEqual(["О блоке", "Руководство", "Состав блока"]);
});

it("offers the service account no application: it is a member of no block (owner 2026-11-08)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const join = vi.spyOn(membershipApi, "join");
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>,
    { path: "/blocks/block-info", session: { ...mock.state.session, service_account: true } });
  await waitForPage(page, () => !!page!.container.querySelector("h1")?.textContent?.trim());
  expect(button(nav(), "Подать заявку в блок")).toBeUndefined();expect(nav().querySelector("form")).toBeNull();
  const note = [...nav().querySelectorAll("span")].find(span => span.textContent === "Сервисный аккаунт не состоит в блоках")!;
  expect(note.className).toMatch(/navNote/);
  // Its other actions stay: it reads every block's tasks.
  expect(texts(nav(), "a")).toContain("Задачи блока");
  expect(join).not.toHaveBeenCalled();
});

it("keeps every action of a plain member reachable and shows no editors to them (D-05)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const block = await openBlock("organizer");
  expect(block.members.some(member => member.user.user_id === mock!.state.session.user_id)).toBe(true);
  expect(texts(nav(), "a")).toEqual(["Задачи блока", "Гайд блока", "Сообщество блока"]);
  expect(nav().querySelector("form")).toBeNull();
  expect(card("О блоке")?.textContent).toContain("Рассказываем о жизни Профкома.");
  expect(page!.container.querySelector('textarea[name="body"]')).toBeNull();
  expect(page!.container.textContent).not.toContain("Изменить описание");
  expect(button(card("Руководство")!, "Изменить руководство")).toBeUndefined();expect(button(card("Руководство")!, "Изменить HR блока")).toBeUndefined();
  expect(texts(card("Руководство")!, "h3")).toEqual(["Мастер блока", "HR блока"]);
  expect(button(card("Состав блока")!, "Убрать")).toBeUndefined();
  expect(card("Состав блока")!.textContent).toContain("Чтобы выйти из блока");
});

it("names the guide in the header when it cannot be opened yet, in the header's ink (D-05)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });mock.state.blocks[0].guide_material_id = null;
  await openBlock("organizer");
  const note = [...nav().querySelectorAll("span")].find(span => span.textContent === "Гайд ещё готовится")!;
  expect(note.className).toMatch(/navNote/);
});

it("shows «О блоке» without a description only to those who may write one (D-05)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });mock.state.blocks[0].description = richText("  ");
  await openBlock("organizer");
  expect(card("О блоке")).toBeUndefined();
  await page!.cleanup();page = undefined;mock.restore();
  mock = installMockTransport("chair", { delay: 0 });mock.state.blocks[0].description = richText("");
  await openBlock();
  const about = card("О блоке")!;
  expect(about.querySelector('[class*="markdown"]')).toBeNull();
  expect(about.querySelector(":scope > details > summary")?.textContent).toBe("Изменить описание");
});

it("opens the description form in place and keeps its draft while it is closed (D-05)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const block = await openBlock();
  const details = card("О блоке")!.querySelector<HTMLDetailsElement>(":scope > details")!;
  expect(details.open).toBe(false);
  await act(async () => details.querySelector("summary")!.click());expect(details.open).toBe(true);
  await change(field(details, "body"), "Черновик описания блока");
  await act(async () => details.querySelector("summary")!.click());expect(details.open).toBe(false);
  // Closing hides the form, it does not unmount it: the draft and the leave warning stay.
  expect(field(details, "body").value).toBe("Черновик описания блока");
  await act(async () => details.querySelector("summary")!.click());
  const command = vi.spyOn(membershipApi, "updateBlock");
  await submit(details.querySelector("form")!);await waitForPage(page!);
  expect(command).toHaveBeenCalledWith(block.block_id, expect.objectContaining({ description: richText("Черновик описания блока"), expected_revision: 1 }));
});

it("reads the master with the deputies beside the block's HR, with one change button in the heading (D-05)", async () => {
  mock = installMockTransport("chair", { delay: 0 });await openBlock();
  const leadership = card("Руководство")!;
  const change = button(leadership, "Изменить руководство")!;
  expect(change.parentElement!.querySelector("h2")?.textContent).toBe("Руководство");
  const [master, hr] = [...leadership.querySelectorAll("h3")].map(heading => heading.parentElement!);
  expect(master.querySelector("li")?.textContent).toContain("Заместители:");
  expect(master.querySelector('li button')).toBeNull();
  expect(hr.querySelector('button[aria-label="Изменить HR блока"]')).not.toBeNull();
  expect(leadership.lastElementChild?.textContent).toContain("Служебное назначение мастера или заместителя");
  expect(card("Состав блока")!.textContent).not.toContain("Служебное назначение");
});

it("removes a member by a short «Убрать» that names the member and still asks first (D-05)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const block = await openBlock();const member = block.members[0].user;
  const remove = button(card("Состав блока")!, `Убрать из состава: ${member.display_name}`)!;
  expect(remove.textContent).toBe("Убрать");expect(remove.title).toBe(`Убрать из состава: ${member.display_name}`);
  expect(remove.closest("li")?.textContent).toContain(member.display_name);
  const command = vi.spyOn(membershipApi, "remove");
  await submit(remove.closest("form")!);
  expect(command).not.toHaveBeenCalled();
  expect(remove.closest("form")!.querySelector('[role="alert"]')?.textContent).toContain(`Исключить ${member.display_name} из блока «${block.name}»?`);
  await act(async () => button(remove.closest("form")!, "Да, исключить")!.click());await waitForPage(page!);
  expect(command).toHaveBeenCalledWith(block.block_id, member.user_id);
});

it("shows an application in the header once it is sent, with its way to the requests (D-05)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });mock.state.blocks[0].members = [];
  await openBlock("organizer");
  await submit(button(nav(), "Подать заявку в блок")!.closest("form")!);
  await waitForPage(page!, () => !nav().querySelector("form"));
  expect(nav().querySelector("p")?.textContent).toMatch(/^Заявка: На рассмотрении HR · Открыть$/);
  expect(nav().querySelector('p a[href="/blocks/requests"]')?.textContent).toBe("Открыть");
});

it("keeps the phone variants of the leader rows and the member rows (D-04, D-05)", () => {
  const phone = (file: string) => [...readFileSync(`${__dirname}/${file}`, "utf8").matchAll(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/g)].map(match => match[1]).join("\n");
  const rows = phone("EventEditor.module.css");
  // The leader and the pencil share the first line; that leader's deputies go under them, indented.
  expect(rows).toMatch(/\.leaderRow>\.iconButton\s*\{[^}]*grid-column:2;grid-row:1/);
  expect(rows).toMatch(/\.leaderRow>\.deputies\s*\{[^}]*grid-column:1\/-1;grid-row:2;padding-left:14px/);
  // A narrow column on a wider screen (the block's master beside its HR) stacks the same way.
  const narrow = readFileSync(`${__dirname}/EventEditor.module.css`, "utf8").match(/@container \(max-width:34rem\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  expect(narrow).toMatch(/\.leaderRow>\.deputies\s*\{[^}]*grid-column:1\/-1;grid-row:2/);
  const block = phone("MembershipPages.module.css");
  expect(block).toMatch(/\.leadership\s*\{\s*grid-template-columns:minmax\(0,1fr\)/);
  expect(block).toMatch(/\.members \.member\.member\s*\{\s*flex-wrap:nowrap/);
  // The removal's question is never squeezed beside the name.
  expect(block).toMatch(/:has\(>form \[role="alert"\]\)\s*\{\s*flex-wrap:wrap/);
});
