// @vitest-environment jsdom
import { act } from 'react';
import { Route,Routes,useLocation } from 'react-router-dom';
import { afterEach,expect,it,vi } from 'vitest';
import { EventsListPage } from './EventPages';
import { eventsApi } from '../../utils/api/events.api';
import { seasonsApi } from '../../utils/api/seasons.api';
import { workspaceApi } from '../../utils/api/workspace.api';
import { createFixtures } from '../../mocks/fixtures';
import { mountWorkspace,waitForPage,change } from '../../test/workspace';
import { ApiError } from '../../utils/api/request';
import type { Event,Participation } from '../../utils/api/contract';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();vi.useRealTimers();});
const stream=()=>page!.container.querySelector('[aria-label="Лента мероприятий"]')!;
const control=(label:string)=>[...page!.container.querySelectorAll('label')].find(node=>node.textContent?.includes(label))!.querySelector('input,select') as HTMLInputElement|HTMLSelectElement;
function Location(){return <output data-location>{useLocation().search}</output>;}
async function mount(path='/events',ordinary=false,clock=false,extraOwn=0){
 vi.useFakeTimers({toFake:clock?['Date','setInterval','clearInterval']:['Date']});vi.setSystemTime(new Date('2026-10-30T09:00:00Z'));
 const fixture=createFixtures('chair'),active={...fixture.seasons[0],season_id:'active',title:'Осень 2026',state:'open' as const},archive={...fixture.seasons[0],season_id:'archive',title:'Весна 2025',state:'closed' as const};
 const base={...fixture.events[0],season_id:active.season_id};
 const events:Event[]=[
 {...base,event_id:'current',title:'Идёт сейчас',starts_at:'2026-10-29T10:00:00Z',ends_at:'2026-10-31T18:00:00Z'},
 {...base,event_id:'late-offset',title:'Поздняя встреча',starts_at:'2026-11-01T00:10:00+03:00',ends_at:null},
 {...base,event_id:'early-offset',title:'Ранняя встреча',starts_at:'2026-10-31T21:05:00Z',ends_at:null},
 {...base,event_id:'undated',title:'Даты ещё неизвестны',starts_at:null,ends_at:null},
 {...base,event_id:'past-current-season',title:'Ранее в текущем сезоне',starts_at:'2026-10-01T09:00:00Z',ends_at:'2026-10-01T10:00:00Z'},
 {...base,event_id:'archived',season_id:archive.season_id,title:'Историческое событие',starts_at:'2025-03-01T09:00:00Z',ends_at:'2025-03-01T10:00:00Z'},
 ];
 const participation:Participation={blocks:[],events:[{event_id:'current',title:'Идёт сейчас',season_id:'active',roles:['organizer']},{event_id:'undated',title:'Даты ещё неизвестны',season_id:'active',roles:['subevent_hr']}]};
 for(let index=0;index<extraOwn;index++){events.push({...base,event_id:'extra-'+index,title:'Личное мероприятие '+index,starts_at:'2026-11-10T12:00:00Z',ends_at:null});participation.events.push({event_id:'extra-'+index,title:'Личное мероприятие '+index,season_id:'active',roles:['organizer']});}
 const eventRequest=vi.spyOn(eventsApi,'list').mockResolvedValue({items:events,next_cursor:null});const seasonRequest=vi.spyOn(seasonsApi,'list').mockResolvedValue({items:[active,archive],next_cursor:null});vi.spyOn(workspaceApi,'participation').mockResolvedValue(participation);
 page=await mountWorkspace(<Routes><Route path="/events" element={<><EventsListPage/><Location/></>}/><Route path="/events/:id" element={<h1>Открыто мероприятие</h1>}/></Routes>,{path,session:ordinary?{...fixture.session,capabilities:[]}:fixture.session});await waitForPage(page);return{eventRequest,seasonRequest};
}
it('uses one compact dated stream, Moscow month groups and instant ordering without repeating current events',async()=>{
 await mount();const groups=[...stream().querySelectorAll('section > h2')].map(node=>node.getAttribute('aria-label'));
 expect(groups).toEqual(['Сейчас идут','Октябрь 2026','Ноябрь 2026','Даты уточняются']);
 expect(stream().querySelectorAll('a[href="/events/current"]')).toHaveLength(1);
 const november=stream().querySelector('section[aria-label="Ноябрь 2026"]')!;expect([...november.querySelectorAll('a')].map(node=>node.getAttribute('href'))).toEqual(['/events/early-offset','/events/late-offset']);
 expect(november.textContent).toContain('01');expect(stream().textContent).not.toContain('Историческое событие');
 const own=page!.container.querySelector('[aria-label="Моё участие в мероприятиях"]')!;expect(own.querySelectorAll('a')).toHaveLength(2);expect(own.textContent).toContain('Организатор');expect(own.textContent).toContain('HR подмероприятия');expect(own.textContent).not.toContain('Поздняя встреча');
 expect(page!.container.querySelector('[aria-label="Ближайшее мероприятие"]')?.textContent).toContain('Ранняя встреча');
});
it('combines search, mine and phase in the URL while native event links retain navigation',async()=>{
 await mount('/events?mine=true&unknown=keep');await change(control('Поиск мероприятий'),'Даты');
 await act(async()=>page!.container.querySelector<HTMLButtonElement>('button[aria-label="Без даты"]')!.click());await waitForPage(page!);
 expect(stream().querySelectorAll('a')).toHaveLength(1);expect(stream().textContent).toContain('Даты ещё неизвестны');const params=new URLSearchParams(page!.container.querySelector('[data-location]')!.textContent!);expect(params.get('mine')).toBe('true');expect(params.get('phase')).toBe('undated');expect(params.get('q')).toBe('Даты');expect(params.get('unknown')).toBe('keep');
 await act(async()=>stream().querySelector<HTMLAnchorElement>('a')!.click());expect(page!.container.querySelector('h1')?.textContent).toBe('Открыто мероприятие');
});
it('keeps archive tied to season state and allows explicit season selection without dropping unrelated filters',async()=>{
 await mount('/events?unknown=keep');await change(control('Период'),'archive');await waitForPage(page!);expect(stream().textContent).toContain('Историческое событие');expect(stream().textContent).not.toContain('Ранее в текущем сезоне');
 await change(control('Период'),'season:active');await waitForPage(page!);let params=new URLSearchParams(page!.container.querySelector('[data-location]')!.textContent!);expect(params.get('season_id')).toBe('active');expect(params.has('archive')).toBe(false);expect(params.get('unknown')).toBe('keep');
 await change(control('Период'),'season:archive');await waitForPage(page!);params=new URLSearchParams(page!.container.querySelector('[data-location]')!.textContent!);expect(params.get('archive')).toBe('true');expect(params.get('season_id')).toBe('archive');
});
it('ordinary actors see the catalogue without invented creation rights or participation',async()=>{
 await mount('/events?q=ничего',true);expect(page!.container.querySelector('a[href="/events/new"]')).toBeNull();expect(stream().textContent).toContain('Мероприятия по выбранным условиям не найдены.');expect(page!.container.querySelector('[aria-label="Моё участие в мероприятиях"]')?.querySelectorAll('a')).toHaveLength(2);
});
it('keeps useful data on transient errors but suppresses cached catalogue data on a permission refusal',async()=>{
 const {eventRequest,seasonRequest}=await mount();eventRequest.mockRejectedValue(new ApiError('Временно недоступно',503,'server_error'));await act(async()=>{await page!.client.invalidateQueries({queryKey:['events']});});await waitForPage(page!);expect(stream().textContent).toContain('Идёт сейчас');
 seasonRequest.mockRejectedValue(new ApiError('Доступ запрещён',403,'forbidden'));await act(async()=>{await page!.client.invalidateQueries({queryKey:['seasons']});});await waitForPage(page!);expect(page!.container.querySelector('[aria-label="Лента мероприятий"]')).toBeNull();expect(page!.container.textContent).not.toContain('Идёт сейчас');expect(page!.container.querySelector('button[aria-label="Все"]')?.textContent).toContain('0');
});

it('refreshes Moscow-day countdown and phases locally at the minute boundary without fetching again',async()=>{
 const {eventRequest,seasonRequest}=await mount('/events',false,true);expect(page!.container.querySelector('[aria-label="Ближайшее мероприятие"]')?.textContent).toContain('Через 2 дн.');
 vi.setSystemTime(new Date('2026-10-31T20:59:30Z'));await act(async()=>{vi.advanceTimersByTime(60000);});await waitForPage(page!);
 expect(page!.container.querySelector('[aria-label="Ближайшее мероприятие"]')?.textContent).toContain('Сегодня');expect(stream().querySelector('section[aria-label="Сейчас идут"]')).toBeNull();expect(eventRequest).toHaveBeenCalledTimes(1);expect(seasonRequest).toHaveBeenCalledTimes(1);
});

it('keeps a large personal sidebar at five entries while the full mine feed stays available',async()=>{
 await mount('/events?unknown=keep',false,false,7);const sidebar=page!.container.querySelector('[aria-label="Ваши мероприятия"]')!;expect(sidebar.querySelectorAll('[aria-label="Моё участие в мероприятиях"] a')).toHaveLength(5);expect(sidebar.querySelector('h2[aria-label="С моим участием"] span')?.textContent).toBe('9');
 await act(async()=>[...sidebar.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Все мои мероприятия')!.click());await waitForPage(page!);const params=new URLSearchParams(page!.container.querySelector('[data-location]')!.textContent!);expect(params.get('mine')).toBe('true');expect(params.get('unknown')).toBe('keep');expect(stream().querySelectorAll('a')).toHaveLength(9);
});
