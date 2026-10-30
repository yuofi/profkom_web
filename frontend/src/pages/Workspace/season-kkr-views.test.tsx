// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFixtures } from '../../mocks/fixtures';
import { mountWorkspace, waitForPage, change, submit } from '../../test/workspace';
import { membershipApi } from '../../utils/api/membership.api';
import { kkrApi, type AccountingStatistic } from '../../utils/api/kkr.api';
import { SeasonStatistics, SeasonKkrControl, SeasonKkrHistory } from './SeasonKkrViews';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
beforeEach(()=>{vi.spyOn(membershipApi,'blocks').mockResolvedValue(createFixtures('chair').blocks);});
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();});
const row:AccountingStatistic={source_kind:'block',source_id:'block-it',title:'IT',parent_title:null,value:1,revision:1,capabilities:['edit_coefficient'],task_count:3,people_count:2,tasks_per_person:1.5,mean_kkr:-2,mean_person_hours:3};
it('keeps block and event statistics distinct and saves a zero coefficient with its captured revision',async()=>{
 vi.spyOn(kkrApi,'statistics').mockResolvedValue({items:[row,{...row,source_kind:'event',source_id:'event-1',title:'Событие'}],preliminary:true});const save=vi.spyOn(kkrApi,'coefficient').mockResolvedValue({...row,value:0,revision:2});
 page=await mountWorkspace(<SeasonStatistics seasonId="season-1" summary={createFixtures('chair').summary}/>);await waitForPage(page);
 expect(page.container.querySelector('tbody')?.textContent).toContain('IT');expect(page.container.querySelector('tbody')?.textContent).not.toContain('Событие');
 await act(async()=>page!.container.querySelector<HTMLButtonElement>('button[aria-label="Коэффициент: IT"]')!.click());await change(page.container.querySelector<HTMLInputElement>('input[type="number"]')!,'0');await submit(page.container.querySelector('form')!);await waitForPage(page);
 expect(save).toHaveBeenCalledExactlyOnceWith('season-1',{source_kind:'block',source_id:'block-it',value:0,expected_revision:1});
 await act(async()=>[...page!.container.querySelectorAll('button')].find(button=>button.textContent==='Мероприятия')!.click());expect(page.container.querySelector('tbody')?.textContent).toContain('Событие');
});
it('shows closed-season history as supplied and requests the configured last four seasons',async()=>{
 const fixture=createFixtures('chair');const read=vi.spyOn(kkrApi,'history').mockResolvedValue({seasons:[{season_id:'old',title:'Старый сезон',state:'closed'}],rows:[{participant_id:'p',user:fixture.user,group_number:'301',cells:[{season_id:'old',rank:3,total_score:-2,decisions:['nice'],preliminary:false}]}]});
 page=await mountWorkspace(<SeasonKkrHistory/>);await waitForPage(page);expect(read).toHaveBeenCalledWith({count:4,search:'',block_id:undefined,course:undefined});expect(page.container.querySelector('tbody')?.textContent).toContain('-2');expect(page.container.querySelector('tbody')?.textContent).toContain('место 3');expect(page.container.querySelector('tbody')?.textContent).toContain('Найс');
});
it('links missing accounting directly into a task and uses one normal summon command per click',async()=>{
 const fixture=createFixtures('chair');vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:['remind_kkr'],items:[{control_id:'c',task_id:'epic',title:'Контроль IT',source_kind:'block',source_id:'block-it',status:'open',responsibles:[fixture.user],missing_count:1,missing_tasks:[{task_id:'work',title:'Работа',task_key:'IT-1',missing_assignees:[fixture.user]}]}]});const remind=vi.spyOn(kkrApi,'remind').mockResolvedValue({comments_created:1});
 page=await mountWorkspace(<SeasonKkrControl seasonId="season-1"/>);await waitForPage(page);expect(page.container.querySelector('a[href="/tasks/work?kkr=1"]')).not.toBeNull();
 for(let i=0;i<2;i++){await act(async()=>[...page!.container.querySelectorAll('button')].find(button=>button.textContent==='Призвать на заполнение')!.click());await waitForPage(page);}expect(remind).toHaveBeenCalledTimes(2);
});
it('does not offer the summon action without its server capability',async()=>{
 vi.spyOn(kkrApi,'controls').mockResolvedValue({capabilities:[],items:[]});page=await mountWorkspace(<SeasonKkrControl seasonId="season-1"/>);await waitForPage(page);expect([...page.container.querySelectorAll('button')].some(button=>button.textContent==='Призвать на заполнение')).toBe(false);
});
it('offers current blocks absent from the historical summary snapshot',async()=>{
 const fixture=createFixtures('chair');vi.mocked(membershipApi.blocks).mockResolvedValue([{...fixture.blocks[0],block_id:'new-current-block',name:'Текущий новый блок'}]);vi.spyOn(kkrApi,'history').mockResolvedValue({seasons:[],rows:[]});
 page=await mountWorkspace(<SeasonKkrHistory/>);await waitForPage(page);
 const input=page.container.querySelector<HTMLInputElement>('[data-field-name="history-block"] [role="combobox"]')!;await act(async()=>{input.focus();input.click();});await waitForPage(page);
 expect(document.querySelector('[role="listbox"]')?.textContent).toContain('Текущий новый блок');
});
