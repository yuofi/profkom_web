// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfilePage } from "../ProfilePage/ProfilePage";
import { ProfileSettingsPage } from "../ProfilePage/ProfileSettingsPage";
import { SeasonsPage, KkrTemplatesPage } from "./SeasonPages";
import { ProfileAchievements } from "../../components/Workspace/ProfileAchievements";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { profileFeaturesApi, type AchievementGrant } from "../../utils/api/profileFeatures.api";
import { ApiError } from "../../utils/api/request";
import { UserContext } from "../../utils/me";
import { SessionContext } from "../../utils/session";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import type { MockRole } from "../../mocks/fixtures";
vi.mock("../../assets/vk.svg?react", () => ({ default: () => null }));
vi.mock("../../assets/telegram.svg?react", () => ({ default: () => null }));
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let guarded: Awaited<ReturnType<typeof mountGuarded>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
  Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.open=false;}});
});
afterEach(async()=>{await page?.cleanup();page=undefined;await guarded?.cleanup();guarded=undefined;mock?.restore();mock=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
const routes=<Routes><Route path="/profile" element={<ProfilePage/>}/><Route path="/profile/settings" element={<ProfileSettingsPage/>}/><Route path="/seasons" element={<SeasonsPage/>}/><Route path="/seasons/templates" element={<KkrTemplatesPage/>}/><Route path="/seasons/:id" element={<p>Один сезон</p>}/></Routes>;
const button=(root:ParentNode,label:string)=>[...root.querySelectorAll<HTMLButtonElement>("button")].find(item=>item.textContent===label||item.getAttribute("aria-label")===label)!;
async function click(element:HTMLElement){expect(element).toBeDefined();await act(async()=>element.click());}
async function open(path:string,role:MockRole="chair"){
  mock=installMockTransport(role,{delay:0});page=await mountWorkspace(<UserContext.Provider value={mock.state.profile}>{routes}</UserContext.Provider>,{path,role});await waitForPage(page);return page;
}
function grant(id:string,extra:Partial<AchievementGrant>={}):AchievementGrant{
  const actor={user_id:101,display_name:"Руководитель награждения",avatar_url:null},created="2026-10-28T12:00:00Z";
  return{grant_id:id,achievement_id:"award-1",achievement:{title:"Помощь команде",description:"Подробное описание вклада",icon:"workspace_premium",scope:{kind:"global",id:null,name:"Профком"}},user:actor,issued_by:actor,issued_at:created,note:null,revoked_at:null,revoked_by:null,revoke_reason:null,revision:1,capabilities:[],history:[{event_id:"event-"+id,kind:"issued",actor,created_at:created}],...extra};
}
it("profile keeps settings behind its gear link and does not load notification preferences or templates",async()=>{
  await open("/profile");const settings=page!.container.querySelector<HTMLAnchorElement>('a[href="/profile/settings"]')!;
  expect(settings.textContent).toContain("Настройки");expect(settings.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(page!.container.textContent).not.toContain("Уведомления вне сайта");expect(page!.container.textContent).not.toContain("Шаблоны ККР");
  expect(mock!.adapter.history.get.some(r=>/notification-preferences|kkr-templates/.test(r.url??""))).toBe(false);
  await click(settings);await waitForPage(page!);expect(page!.container.querySelector("h1")?.textContent).toBe("Настройки профиля");expect(page!.container.textContent).toContain("Уведомления вне сайта");expect([...page!.container.querySelectorAll('a[href="/profile"]')].some(link=>link.textContent?.includes("К профилю"))).toBe(true);
});
it("season catalogue opens templates without a global summary permission or automatic editor",async()=>{
  await open("/seasons","leader");expect(mock!.state.session.capabilities).not.toContain("view_summary");
  const link=page!.container.querySelector<HTMLAnchorElement>('a[href="/seasons/templates"]')!;expect(link.textContent).toContain("Шаблоны ККР");expect(page!.container.querySelector("form")).toBeNull();expect(mock!.adapter.history.get.some(r=>r.url==="/kkr-templates")).toBe(false);
  await click(link);await waitForPage(page!);expect(page!.container.querySelector("h1")?.textContent).toBe("Шаблоны ККР");expect(page!.container.querySelector("form")).toBeNull();await click(button(page!.container,"Создать шаблон ККР"));expect(field(page!.container,"title").value).toBe("");
});
it("ordinary readers cannot create or manage templates on the new page",async()=>{
  await open("/seasons/templates","organizer");expect(page!.container.textContent).toContain("Пока нет доступных шаблонов");expect(button(page!.container,"Создать шаблон ККР")).toBeUndefined();expect(page!.container.querySelector("form")).toBeNull();
});
it("award badges preserve repeated issues, open details on activation and restore focus after Escape",async()=>{
  mock=installMockTransport("organizer",{delay:0});const focus=vi.spyOn(HTMLElement.prototype,"focus");const first=grant("first"),repeated=grant("repeat"),revoked=grant("revoked",{revoked_at:"2026-10-29T12:00:00Z",revoked_by:first.issued_by});vi.spyOn(profileFeaturesApi,"achievements").mockResolvedValue({items:[first,repeated,revoked]});
  page=await mountWorkspace(<ProfileAchievements userId={101}/>,{role:"organizer"});await waitForPage(page);
  const badges=page.container.querySelectorAll<HTMLButtonElement>('[data-achievement-grant]');expect(badges).toHaveLength(2);expect(page.container.querySelector("article")).toBeNull();expect(page.container.textContent).not.toContain(first.achievement.description);
  await act(async()=>{badges[0].focus();badges[0].click();});await waitForPage(page);const popup=document.querySelector<HTMLElement>('[data-anchored-popover]')!;expect(popup.textContent).toContain(first.achievement.description);expect(popup.textContent).toContain(first.issued_by.display_name);expect(document.activeElement).toBe(popup);expect(focus.mock.calls.some(args=>args[0]?.preventScroll===true)).toBe(true);expect(popup.textContent).not.toContain("Отозвать");
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));await waitForPage(page);expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(document.activeElement).toBe(badges[0]);
  await click(page.container.querySelector("summary")!);expect(page.container.querySelectorAll("article")).toHaveLength(3);expect(page.container.textContent).toContain("Отозвана");
});
it("historical unknown icons fall back safely and public details show no service fields or management",async()=>{
  mock=installMockTransport("organizer",{delay:0});vi.spyOn(profileFeaturesApi,"achievements").mockResolvedValue({items:[grant("unknown",{achievement:{...grant("x").achievement,icon:"untrusted-icon-name"}})]});page=await mountWorkspace(<ProfileAchievements userId={101}/>,{role:"organizer"});await waitForPage(page);
  const badge=page.container.querySelector<HTMLButtonElement>('[data-achievement-grant]')!;expect(badge.querySelector('[data-icon="workspace_premium"]')).not.toBeNull();await click(badge);await waitForPage(page);
  const popup=document.querySelector('[data-anchored-popover]')!;expect(popup.textContent).not.toContain("Основание отзыва");expect(popup.querySelector("form")).toBeNull();expect(page.container.textContent).not.toContain("Каталог и управление наградами");expect(page.container.textContent).not.toContain("Выдать награду");
});
it("permission loss clears open award details instead of keeping sensitive cached text",async()=>{
  mock=installMockTransport("chair",{delay:0});const read=vi.spyOn(profileFeaturesApi,"achievements").mockResolvedValue({items:[grant("private",{note:"Служебная заметка получателю"})]});page=await mountWorkspace(<ProfileAchievements userId={101}/>);await waitForPage(page);await click(page.container.querySelector<HTMLButtonElement>('[data-achievement-grant]')!);await waitForPage(page);expect(document.querySelector('[data-anchored-popover]')?.textContent).toContain("Служебная заметка получателю");
  read.mockRejectedValue(new ApiError("Нет доступа",403));await act(async()=>{await page!.client.invalidateQueries({queryKey:["profileAchievements",101]});});await waitForPage(page);expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(document.body.textContent).not.toContain("Служебная заметка получателю");
});
it("a refused revocation keeps the entered reason and the open award details",async()=>{
  mock=installMockTransport("chair",{delay:0});const row=grant("stale",{capabilities:["revoke_achievement"]});vi.spyOn(profileFeaturesApi,"achievements").mockResolvedValue({items:[row]});const revoke=vi.spyOn(profileFeaturesApi,"revoke").mockRejectedValue(new ApiError("Обновите запись",409,"revision_conflict"));
  page=await mountWorkspace(<ProfileAchievements userId={101}/>);await waitForPage(page);await click(page.container.querySelector<HTMLButtonElement>('[data-achievement-grant]')!);await waitForPage(page);const popup=document.querySelector<HTMLElement>('[data-anchored-popover]')!;await click(popup.querySelector("summary")!);await change(field(popup,"reason"),"Причина должна сохраниться");await submit(popup.querySelector("form")!);await waitForPage(page);
  expect(revoke).toHaveBeenCalledWith(expect.objectContaining({revision:1}),"Причина должна сохраниться");expect(popup.isConnected).toBe(true);expect(field(popup,"reason").value).toBe("Причина должна сохраниться");expect(popup.querySelector('[role="alert"]')).not.toBeNull();
});
async function mountGuarded(path:string,award=false){
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container),client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  const router=createMemoryRouter([{element:<UnsavedChangesProvider><Outlet/></UnsavedChangesProvider>,children:award?[{path:"/awards",element:<><ActionForm fields={[{name:"other",label:"Другой редактор"}]} onSubmit={async()=>{}}/><ProfileAchievements userId={101}/></>}]:[{path:"/profile/settings",element:<ProfileSettingsPage/>},{path:"/profile",element:<p>Обзор профиля</p>}]}],{initialEntries:[path]});
  await act(async()=>root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{session:mock!.state.session,loading:false,error:null,refresh:()=>{}}}><RouterProvider router={router}/></SessionContext.Provider></QueryClientProvider>));const result={container,client,router,cleanup:async()=>{await act(async()=>root.unmount());router.dispose();client.clear();container.remove();}};await waitForPage(result);return result;
}
it("closing a dirty award popover protects its reason without discarding an unrelated editor",async()=>{
  mock=installMockTransport("chair",{delay:0});vi.spyOn(profileFeaturesApi,"achievements").mockResolvedValue({items:[grant("managed",{note:"Приватная заметка",capabilities:["revoke_achievement"]})]});const revoke=vi.spyOn(profileFeaturesApi,"revoke");guarded=await mountGuarded("/awards",true);await change(field(guarded.container,"other"),"Другой черновик");await click(guarded.container.querySelector<HTMLButtonElement>('[data-achievement-grant]')!);await waitForPage(guarded);
  const popup=document.querySelector<HTMLElement>('[data-anchored-popover]')!;await click(popup.querySelector("summary")!);await change(field(popup,"reason"),"Сохранить причину отзыва");const close=()=>click(popup.querySelector<HTMLButtonElement>('[aria-label="Закрыть окно"]')!);await close();await waitForPage(guarded);expect(guarded.container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");
  await click(button(guarded.container,"Остаться"));expect(field(popup,"reason").value).toBe("Сохранить причину отзыва");await close();await click(button(guarded.container,"Уйти без сохранения"));await waitForPage(guarded);expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(field(guarded.container,"other").value).toBe("Другой черновик");expect(revoke).not.toHaveBeenCalled();
});
it("leaving notification settings protects its unsaved channel selection",async()=>{
  mock=installMockTransport("chair",{delay:0});guarded=await mountGuarded("/profile/settings");const checkbox=guarded.container.querySelector<HTMLInputElement>('input[aria-label="Изменения тикетов трекера: Почта"]')!;await click(checkbox);const back=()=>click(guarded!.container.querySelector<HTMLAnchorElement>('a[href="/profile"]')!);await back();await waitForPage(guarded);await click(button(guarded.container,"Остаться"));expect(checkbox.checked).toBe(true);expect(guarded.router.state.location.pathname).toBe("/profile/settings");await back();await click(button(guarded.container,"Уйти без сохранения"));await waitForPage(guarded);expect(guarded.router.state.location.pathname).toBe("/profile");expect(mock.adapter.history.put).toHaveLength(0);
});
