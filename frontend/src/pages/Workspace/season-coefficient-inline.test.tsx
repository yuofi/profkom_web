// @vitest-environment jsdom
import {act} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {createFixtures} from '../../mocks/fixtures';
import {mountWorkspace,waitForPage,change} from '../../test/workspace';
import {kkrApi,type AccountingStatistic} from '../../utils/api/kkr.api';
import {ApiError} from '../../utils/api/request';
import {SeasonStatistics} from './SeasonKkrViews';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();});
const row:AccountingStatistic={source_kind:'block',source_id:'block-it',title:'IT',parent_title:null,value:1,revision:1,capabilities:['edit_coefficient'],task_count:1,people_count:1,tasks_per_person:1,mean_kkr:1,mean_person_hours:1};
const coefficient=()=>page!.container.querySelector<HTMLInputElement>('input[aria-label="Коэффициент: IT"]')!;
const enter=()=>act(async()=>coefficient().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
const blur=()=>act(async()=>coefficient().dispatchEvent(new FocusEvent('focusout',{bubbles:true})));
async function mount(preliminary=true){vi.spyOn(kkrApi,'statistics').mockResolvedValue({items:[row],preliminary});page=await mountWorkspace(<SeasonStatistics seasonId="season-1" summary={{...createFixtures('chair').summary,state:preliminary?'draft':'approved',version:8}}/>);await waitForPage(page);}
it('uses a direct default-one field and coalesces Enter plus blur into one CAS save',async()=>{
 let resolve!:(value:typeof row)=>void;const save=vi.spyOn(kkrApi,'coefficient').mockReturnValue(new Promise(done=>{resolve=done;}));await mount();expect(coefficient().value).toBe('1');expect(page!.container.querySelector('form')).toBeNull();
 await change(coefficient(),'0');await enter();await blur();expect(save).toHaveBeenCalledExactlyOnceWith('season-1',{source_kind:'block',source_id:'block-it',value:0,expected_revision:1});expect(coefficient().disabled).toBe(true);await act(async()=>resolve({...row,value:0,revision:2}));await waitForPage(page!);
});
it('rejects empty and negative values, while Escape discards without an accidental blur save',async()=>{
 const save=vi.spyOn(kkrApi,'coefficient');await mount();for(const invalid of ['', '-1']){await change(coefficient(),invalid);await enter();expect(page!.container.querySelector('[role="alert"]')?.textContent).toContain('неотрицательный');}expect(save).not.toHaveBeenCalled();
 await change(coefficient(),'2');await act(async()=>{coefficient().focus();coefficient().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});expect(save).not.toHaveBeenCalled();expect(coefficient().value).toBe('1');
});
it('preserves a stale draft and requires an explicit retry with the refreshed revision',async()=>{
 const save=vi.spyOn(kkrApi,'coefficient').mockRejectedValueOnce(new ApiError('Конфликт',409,'revision_conflict')).mockResolvedValue({...row,value:2,revision:4});await mount();vi.mocked(kkrApi.statistics).mockResolvedValue({items:[{...row,value:3,revision:3}],preliminary:true});
 await change(coefficient(),'2');await enter();await waitForPage(page!);expect(coefficient().value).toBe('2');expect(save).toHaveBeenCalledTimes(1);await blur();expect(save).toHaveBeenCalledTimes(1);
 const retry=[...page!.container.querySelectorAll('button')].find(button=>button.textContent==='Сохранить мой ввод с обновлённой версией')!;await act(async()=>retry.click());await waitForPage(page!);expect(save.mock.calls[1][1]).toMatchObject({value:2,expected_revision:3});
});
it('opens one audit form for a closed season and sends its reason and captured summary version',async()=>{
 const save=vi.spyOn(kkrApi,'coefficient').mockResolvedValue({...row,value:2,revision:2});await mount(false);await change(coefficient(),'2');await enter();await waitForPage(page!,()=>!!document.querySelector('[data-anchored-popover] input'));
 expect(save).not.toHaveBeenCalled();expect(document.querySelectorAll('[data-anchored-popover] form')).toHaveLength(1);
 const form=document.querySelector<HTMLFormElement>('[data-anchored-popover] form')!;await change(form.querySelector('input')!,'Проверенное исправление');await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await waitForPage(page!);
 expect(save).toHaveBeenCalledExactlyOnceWith('season-1',{source_kind:'block',source_id:'block-it',value:2,expected_revision:1,reason:'Проверенное исправление',expected_summary_version:8});
});
