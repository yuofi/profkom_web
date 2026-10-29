// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { workspaceApi } from "../../utils/api/workspace.api";
import { richText } from "../../utils/api/contract";
import { moscowDay } from "../../utils/calendar";
import { CalendarPage } from "./WorkspacePages";
import { SubeventPage } from "./EventPages";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;});

it("real HTTP: public child announcements and cross-month calendar do not open private team data", async()=>{
  const outsider=await liveParticipant("public-event-visitor");await liveLogin();
  const available=(await seasonsApi.list()).items;let season=available.find(item=>item.state==="open");
  if(!season){const planned=available.find(item=>item.state==="planned")??await seasonsApi.create({title:"Public event HTTP",type:"summer_autumn",starts_at:new Date(Date.now()-86400000).toISOString(),ends_at:new Date(Date.now()+45*86400000).toISOString()});const opened=await seasonsApi.command(planned.season_id,"open",{expected_revision:planned.revision});season="season"in opened?opened.season:opened;}
  const today=moscowDay(new Date().toISOString()),month=today.slice(0,7),monthStart=new Date(`${month}-01T00:00:00+03:00`),start=new Date(monthStart.getTime()-86400000).toISOString(),end=new Date(monthStart.getTime()+2*86400000+12*3600000).toISOString();
  const event=await eventsApi.create({season_id:season.season_id,title:"HTTP multi-day public event",description:richText("Public event"),starts_at:start,ends_at:end});
  const child=await eventsApi.createSubevent(event.event_id,{title:"HTTP safe announcement",description:richText("PRIVATE TEAM TEXT"),announcement:richText("Анонс для всех активистов"),starts_at:start,ends_at:end});
  const session=await liveLogin(outsider.email);const safe=await eventsApi.subevent(child.subevent_id);
  expect(safe.working_access).toBe(false);expect(safe.description.body).toBe("");expect(safe.report_series_id).toBeNull();expect(safe.capabilities).toEqual([]);
  page=await mountWorkspace(<Routes><Route path="/subevents/:id" element={<SubeventPage/>}/></Routes>,{path:`/subevents/${child.subevent_id}`,session});await waitForPage(page);
  expect(page.container.textContent).toContain("Анонс для всех активистов");expect(page.container.textContent).not.toContain("PRIVATE TEAM TEXT");expect(page.container.textContent).not.toContain("Задачи команды");
  await page.cleanup();page=undefined;
  const calendar=await workspaceApi.calendar(monthStart.toISOString(),new Date(monthStart.getTime()+3*86400000).toISOString(),{mine:false,event_id:event.event_id});
  expect(calendar.items.some(item=>item.target.id===child.subevent_id)).toBe(true);
  page=await mountWorkspace(<CalendarPage/>,{path:`/calendar?month=${month}&mine=false&event_id=${event.event_id}`,session});await waitForPage(page);
  expect(page.container.querySelector(`[aria-label="${month}-01"]`)?.textContent).toContain(event.title);
  expect(page.container.querySelector(`[aria-label="${month}-02"]`)?.textContent).toContain(event.title);
  expect(page.container.querySelector(`[aria-label="${month}-04"]`)?.textContent).not.toContain(event.title);
});
