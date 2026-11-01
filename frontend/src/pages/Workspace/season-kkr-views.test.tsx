// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFixtures } from '../../mocks/fixtures';
import { mountWorkspace, waitForPage, change, pick } from '../../test/workspace';
import { membershipApi } from '../../utils/api/membership.api';
import { kkrApi, type AccountingStatistic, type KkrControl } from '../../utils/api/kkr.api';
import { Route, Routes } from 'react-router-dom';
import { installMockTransport } from '../../mocks/transport';
import { SeasonStatistics, SeasonKkrControl, SeasonKkrHistory, SeasonKkrSummon } from './SeasonKkrViews';
import { SeasonPage } from './SeasonPages';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
beforeEach(()=>{vi.spyOn(membershipApi,'blocks').mockResolvedValue(createFixtures('chair').blocks);});
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();});
const row:AccountingStatistic={source_kind:'block',source_id:'block-it',title:'IT',parent_title:null,value:1,revision:1,capabilities:['edit_coefficient'],task_count:3,people_count:2,tasks_per_person:1.5,mean_kkr:-2,mean_person_hours:3};
it('keeps block and event statistics distinct and saves a zero coefficient with its captured revision',async()=>{
 vi.spyOn(kkrApi,'statistics').mockResolvedValue({items:[row,{...row,source_kind:'event',source_id:'event-1',title:'Событие'}],preliminary:true});const save=vi.spyOn(kkrApi,'coefficient').mockResolvedValue({...row,value:0,revision:2});
 page=await mountWorkspace(<SeasonStatistics seasonId="season-1" summary={createFixtures('chair').summary}/>);await waitForPage(page);
 expect(page.container.querySelector('tbody')?.textContent).toContain('IT');expect(page.container.querySelector('tbody')?.textContent).not.toContain('Событие');
 await change(page.container.querySelector<HTMLInputElement>('input[aria-label="Коэффициент: IT"]')!,'0');await act(async()=>page!.container.querySelector('input[aria-label="Коэффициент: IT"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));await waitForPage(page);
 expect(save).toHaveBeenCalledExactlyOnceWith('season-1',{source_kind:'block',source_id:'block-it',value:0,expected_revision:1});
 await act(async()=>[...page!.container.querySelectorAll('button')].find(button=>button.textContent==='Мероприятия')!.click());expect(page.container.querySelector('tbody')?.textContent).toContain('Событие');
});
it('shows closed-season history as supplied and requests the configured last four seasons',async()=>{
 const fixture=createFixtures('chair');const read=vi.spyOn(kkrApi,'history').mockResolvedValue({seasons:[{season_id:'old',title:'Старый сезон',state:'closed'}],rows:[{participant_id:'p',user:fixture.user,group_number:'301',cells:[{season_id:'old',rank:3,total_score:-2,decisions:['nice'],preliminary:false}]}]});
 page=await mountWorkspace(<SeasonKkrHistory/>);await waitForPage(page);expect(read).toHaveBeenCalledWith({count:4});expect(page.container.querySelector('tbody')?.textContent).toContain('-2');expect(page.container.querySelector('tbody')?.textContent).toContain('место 3');expect(page.container.querySelector('tbody')?.textContent).toContain('Найс');
});
it('loads the history once per season count and filters name, course and current block locally (PB-29)',async()=>{
 const fixture=createFixtures('chair'),block=fixture.blocks[0];
 const person=(user_id:number,display_name:string,group_number:string|null)=>({participant_id:`p-${user_id}`,user:{user_id,display_name,avatar_url:null},group_number,cells:[]});
 const member=block.members[0].user;
 const read=vi.spyOn(kkrApi,'history').mockResolvedValue({seasons:[],rows:[person(member.user_id!,'Член Блока','201'),person(9001,'Анна Поиск','301'),person(9002,'Борис Другой',null)]});
 page=await mountWorkspace(<SeasonKkrHistory/>);await waitForPage(page);
 const names=()=>[...page!.container.querySelectorAll('tbody tr')].map(row=>row.querySelector('td')?.textContent??'');
 expect(names()).toHaveLength(3);
 await change(page.container.querySelector<HTMLInputElement>('input[type="search"]')!,'поиск');expect(names()).toEqual([expect.stringContaining('Анна Поиск')]);
 await change(page.container.querySelector<HTMLInputElement>('input[type="search"]')!,'');
 const course=[...page.container.querySelectorAll('label')].find(label=>label.textContent?.startsWith('Курс'))!.querySelector('select')!;
 await change(course,'2');expect(names()).toEqual([expect.stringContaining('Член Блока')]);await change(course,'');
 await pick(page.container,'history-block',block.block_id);expect(names()).toEqual([expect.stringContaining('Член Блока')]);
 expect(read).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledWith({count:4});
});
it('keeps the seasons count editable and shows an absent season as a dash without repeated empty marks',async()=>{
 const fixture=createFixtures('chair');const read=vi.spyOn(kkrApi,'history').mockResolvedValue({seasons:[{season_id:'old',title:'Старый сезон',state:'closed'},{season_id:'now',title:'Текущий сезон',state:'open'}],rows:[{participant_id:'p',user:fixture.user,group_number:'301',cells:[{season_id:'old',rank:null,total_score:null,decisions:[],preliminary:false},{season_id:'now',rank:2,total_score:5,decisions:[],preliminary:true}]}]});
 page=await mountWorkspace(<SeasonKkrHistory/>);await waitForPage(page);
 const cells=[...page.container.querySelectorAll('tbody td')];expect(cells[1].textContent).toBe('—');expect(cells[2].textContent).toBe('5место 2');expect(page.container.querySelector('tbody')?.textContent).not.toContain('Нет отметок');
 expect(page.container.querySelector('thead th:last-child small')?.textContent).toBe('Предварительно');
 const count=page.container.querySelector<HTMLInputElement>('input[type="number"]')!;
 await change(count,'');expect(count.value).toBe('');expect(read).toHaveBeenCalledTimes(1);
 await act(async()=>{count.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));});await waitForPage(page);expect(count.value).toBe('4');expect(read).toHaveBeenCalledTimes(1);
 await change(count,'6');await act(async()=>{count.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));});await waitForPage(page);expect(read).toHaveBeenLastCalledWith(expect.objectContaining({count:6}));
});
it('says a closed season finished its control instead of keeping it open',async()=>{
 const fixture=createFixtures('chair');vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:[],items:[{control_id:'c',task_id:'epic',title:'Контроль IT',source_kind:'block',source_id:'block-it',status:'closed',responsibles:[fixture.user],missing_count:0,missing_tasks:[]}]});
 page=await mountWorkspace(<SeasonKkrControl seasonId="season-1" closed/>);await waitForPage(page);
 expect(page.container.textContent).toContain('Контроль завершён вместе с сезоном.');expect(page.container.textContent).not.toContain('остаётся открытым');
 await page.cleanup();vi.mocked(kkrApi.controls).mockResolvedValue({capabilities:[],items:[{control_id:'c',task_id:'epic',title:'Контроль IT',source_kind:'block',source_id:'block-it',status:'open',responsibles:[fixture.user],missing_count:0,missing_tasks:[]}]});
 page=await mountWorkspace(<SeasonKkrControl seasonId="season-1"/>);await waitForPage(page);
 expect(page.container.textContent).toContain('Контроль остаётся открытым до конца сезона.');
});
it('links missing accounting directly into a task and uses one normal summon command per click',async()=>{
 const fixture=createFixtures('chair');vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:['remind_kkr'],items:[{control_id:'c',task_id:'epic',title:'Контроль IT',source_kind:'block',source_id:'block-it',status:'open',responsibles:[fixture.user],missing_count:1,missing_tasks:[{task_id:'work',title:'Работа',task_key:'IT-1',missing_assignees:[fixture.user]}]}]});const remind=vi.spyOn(kkrApi,'remind').mockResolvedValue({comments_created:1});
 page=await mountWorkspace(<><header><SeasonKkrSummon seasonId="season-1"/></header><SeasonKkrControl seasonId="season-1"/></>);await waitForPage(page);expect(page.container.querySelector('a[href="/tasks/work?kkr=1"]')).not.toBeNull();
 for(let i=0;i<2;i++){await act(async()=>[...page!.container.querySelectorAll('button')].find(button=>button.textContent==='Призвать на заполнение')!.click());await waitForPage(page);}expect(remind).toHaveBeenCalledTimes(2);
});
it('offers the summon action only by the season capability, without reading controls on the hub',async()=>{
 const controls=vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:[],items:[]});const transport=installMockTransport('chair',{delay:0});
 try{
  page=await mountWorkspace(<Routes><Route path="/seasons/:id" element={<SeasonPage/>}/></Routes>,{path:'/seasons/season-1'});await waitForPage(page);
  const summon=()=>[...page!.container.querySelectorAll('button')].some(button=>button.textContent==='Призвать на заполнение');
  expect(summon()).toBe(false);
  page.client.setQueryData(['seasons'],{items:transport.state.seasons.map(season=>season.season_id==='season-1'?{...season,capabilities:[...season.capabilities,'remind_kkr']}:season)});await waitForPage(page);
  expect(summon()).toBe(true);expect(controls).not.toHaveBeenCalled();
 }finally{transport.restore();}
});
it('offers current blocks absent from the historical summary snapshot',async()=>{
 const fixture=createFixtures('chair');vi.mocked(membershipApi.blocks).mockResolvedValue([{...fixture.blocks[0],block_id:'new-current-block',name:'Текущий новый блок'}]);vi.spyOn(kkrApi,'history').mockResolvedValue({seasons:[],rows:[]});
 page=await mountWorkspace(<SeasonKkrHistory/>);await waitForPage(page);
 const input=page.container.querySelector<HTMLInputElement>('[data-field-name="history-block"] [role="combobox"]')!;await act(async()=>{input.focus();input.click();});await waitForPage(page);
 expect(document.querySelector('[role="listbox"]')?.textContent).toContain('Текущий новый блок');
});
it('keeps approved source A as a flat seven-column table with the parent on a secondary line',async()=>{
 const event:AccountingStatistic={...row,source_kind:'event',source_id:'event-stable-id',title:'Главное мероприятие',capabilities:[]};
 const child:AccountingStatistic={...row,source_kind:'subevent',source_id:'child-stable-id',title:'Регистрация и встреча гостей',parent_title:event.title,capabilities:[]};
 vi.spyOn(kkrApi,'statistics').mockResolvedValue({items:[event,child],preliminary:true});
 page=await mountWorkspace(<SeasonStatistics seasonId="season-1"/>);await waitForPage(page);
 await act(async()=>[...page!.container.querySelectorAll('button')].find(button=>button.textContent==='Мероприятия')!.click());
 expect([...page.container.querySelectorAll('thead th')].map(cell=>cell.textContent)).toEqual(['Источник','Коэффициент','Задач','Организаторов','Задач / организатора','Средний ККР','Часов / задачу']);
 const rows=[...page.container.querySelectorAll('tbody tr')];expect(rows).toHaveLength(2);
 const cells=rows[1].querySelectorAll('td');expect(cells).toHaveLength(7);expect(cells[0].firstChild?.textContent).toBe(child.title);expect(cells[0].querySelector('small')?.textContent).toBe(event.title);
 // The editable coefficient is the second column, in view without horizontal scrolling (SE-06).
 expect([...cells].slice(1).map(cell=>cell.textContent)).toEqual(['1','3','2','1,5','-2','3']);
 expect(page.container.querySelector('tbody input')).toBeNull();expect(page.container.querySelector('tbody details')).toBeNull();
 expect(page.container.querySelector('tbody')?.textContent).not.toContain(child.source_id);expect(page.container.querySelector('tbody')?.textContent).not.toContain(event.source_id);
});
const control=(over:Partial<KkrControl>):KkrControl=>({control_id:'c',task_id:'epic',title:'Контроль',source_kind:'block',source_id:'block-it',status:'open',responsibles:[],missing_count:0,missing_tasks:[],...over});
const unfold=async(details:HTMLDetailsElement)=>{await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});await waitForPage(page!);};
it('puts the queues with gaps first, most gaps on top, and folds the filled ones into rows (D-06)',async()=>{
 const fixture=createFixtures('chair'),work=(id:string)=>({task_id:id,title:`Работа ${id}`,task_key:id.toUpperCase(),missing_assignees:[fixture.user]});
 vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:[],items:[control({control_id:'a',task_id:'epic-a',title:'Заполнено А',responsibles:[fixture.user]}),control({control_id:'one',task_id:'epic-one',title:'Один пропуск',missing_count:1,missing_tasks:[work('w1')]}),control({control_id:'b',task_id:'epic-b',title:'Заполнено Б'}),control({control_id:'two',task_id:'epic-two',title:'Два пропуска',missing_count:2,missing_tasks:[work('w2'),work('w3')]})]});
 page=await mountWorkspace(<SeasonKkrControl seasonId="season-1"/>);await waitForPage(page);
 expect(page.container.querySelector('p')?.textContent).toBe('4 очереди · без ККР: 3 задачи · с пропусками: 2');
 // The tab names the view: no «Заполнение ККР» heading repeats it.
 expect([...page.container.querySelectorAll('h2,h3')].map(heading=>heading.textContent)).toEqual(['С пропусками']);
 const gaps=page.container.querySelector('section[aria-label="С пропусками"]')!;
 expect([...gaps.querySelectorAll(':scope>ul>li>div:first-child>a')].map(link=>link.textContent)).toEqual(['Два пропуска','Один пропуск']);
 expect(gaps.querySelector('a[href="/tasks/w2?kkr=1"]')).not.toBeNull();expect(gaps.textContent).not.toContain('Заполнено А');
 const filled=page.container.querySelector<HTMLDetailsElement>('details')!;
 expect(filled.querySelector('summary')?.textContent).toBe('Заполнено · 2');expect(filled.open).toBe(false);
 // Folded rows stay in the page, so the browser's find reaches a queue name.
 expect(filled.querySelector('tbody')?.textContent).toContain('Заполнено А');
 await unfold(filled);
 expect([...filled.querySelectorAll('thead th')].map(cell=>cell.textContent)).toEqual(['Очередь','Ответственные','Без ККР']);
 const rows=[...filled.querySelectorAll('tbody tr')];
 expect(rows.map(row=>row.querySelector('a')?.getAttribute('href'))).toEqual(['/tasks/epic-a','/tasks/epic-b']);
 expect(rows[0].children[1].textContent).toContain(fixture.user.display_name);expect(rows[1].children[1].textContent).toBe('—');expect(rows[1].children[2].textContent).toBe('0 без ККР');
 // With gaps above, the filled queues keep their phrase at the top of the folded list.
 expect(filled.querySelector('p')?.textContent).toBe('Все закрытые задачи заполнены. Контроль остаётся открытым до конца сезона.');
});
it('says the control phrase by status: once when the queues agree, in its own row when one differs (D-06)',async()=>{
 vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:[],items:[control({control_id:'open',title:'Открытый'}),control({control_id:'done',task_id:'epic-done',title:'Завершённый',status:'closed'})]});
 page=await mountWorkspace(<SeasonKkrControl seasonId="season-1"/>);await waitForPage(page);
 expect(page.container.querySelector('section[aria-label="С пропусками"]')?.textContent).toContain('Контроль остаётся открытым до конца сезона.');
 let filled=page.container.querySelector<HTMLDetailsElement>('details')!;await unfold(filled);
 let rows=[...filled.querySelectorAll('tbody tr')];
 expect(rows[0].querySelector('small')).toBeNull();expect(rows[1].querySelector('small')?.textContent).toBe('Контроль завершён вместе с сезоном.');
 expect(filled.querySelector('p')).toBeNull();
 // A closed season finishes every control: the phrase is said once, no row repeats it.
 await page.cleanup();page=await mountWorkspace(<SeasonKkrControl seasonId="season-1" closed/>);await waitForPage(page);
 expect(page.container.querySelector('section[aria-label="С пропусками"]')?.textContent).toContain('Контроль завершён вместе с сезоном.');
 filled=page.container.querySelector<HTMLDetailsElement>('details')!;await unfold(filled);rows=[...filled.querySelectorAll('tbody tr')];
 expect(rows.map(row=>row.querySelector('small'))).toEqual([null,null]);expect(page.container.textContent).not.toContain('остаётся открытым');
});
it('leaves out the folded list when every queue has gaps (D-06)',async()=>{
 const fixture=createFixtures('chair');
 vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:[],items:[control({missing_count:1,missing_tasks:[{task_id:'work',title:'Работа',task_key:'IT-1',missing_assignees:[fixture.user]}]})]});
 page=await mountWorkspace(<SeasonKkrControl seasonId="season-1"/>);await waitForPage(page);
 expect(page.container.querySelector('p')?.textContent).toBe('1 очередь · без ККР: 1 задача · с пропусками: 1');
 expect(page.container.querySelector('details')).toBeNull();expect(page.container.textContent).not.toContain('Все закрытые задачи заполнены');
});
