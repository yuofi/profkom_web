import { expect, it } from 'vitest';
import { people } from '../../mocks/fixtures';
import { newCommentMentionDraft, addCommentMention, changeCommentMentionBody, keepCommentMentions, commentMentionUsers } from './commentMentionDraft';
const target=people[1],other=people[2];
const ids=(draft:ReturnType<typeof newCommentMentionDraft>)=>draft.pending.map(item=>item.user.user_id);
it('manual deletion clears explicit intent even when another typed link to the same user remains',()=>{
 const manual=`Пример [ручная ссылка](/contacts/${target.user_id})`,draft=addCommentMention(newCommentMentionDraft(manual),target),owned=draft.pending[0];
 const next=changeCommentMentionBody(draft,draft.body.slice(0,owned.start)+draft.body.slice(owned.end));
 expect(ids(next)).toEqual([]);expect(next.body).toContain(manual);expect(commentMentionUsers(next)).toEqual([]);
});
it('untag removes only the owned token and keeps identical manual/previous text byte-for-byte',()=>{
 const once=addCommentMention(newCommentMentionDraft(),target).pending[0].token;
 const previous=`Раньше ${once}; текст`,draft=addCommentMention(newCommentMentionDraft(previous),target);
 const shifted=changeCommentMentionBody(draft,'Префикс '+draft.body),next=keepCommentMentions(shifted,[]);
 expect(next.body).toBe('Префикс '+previous+'  ');expect(ids(next)).toEqual([]);
});
it('manual links and edits of old comments never create a fresh notification intent',()=>{
 const body=`Старый [участник](/contacts/${target.user_id})`,draft=newCommentMentionDraft(body);
 const next=changeCommentMentionBody(draft,body+' Ручная [ссылка](/contacts/'+other.user_id+')');
 expect(ids(next)).toEqual([]);expect(commentMentionUsers(next,[target]).map(user=>user.user_id)).toEqual([target.user_id]);
});
it('correcting the target or turning its token into code does not leave stale recipients',()=>{
 const draft=addCommentMention(newCommentMentionDraft('Текст'),target),fixed=addCommentMention(keepCommentMentions(draft,[]),other);
 expect(ids(fixed)).toEqual([other.user_id]);expect(fixed.body).not.toContain('/contacts/'+target.user_id);
 expect(ids(changeCommentMentionBody(draft,'```markdown\n'+draft.body+'\n```'))).toEqual([]);
 expect(ids(changeCommentMentionBody(draft,draft.body.replace('/contacts/'+target.user_id,'/contacts/'+other.user_id)))).toEqual([]);
});
it('preserves selected intent through text edits outside the token and changes of its label',()=>{
 const draft=addCommentMention(newCommentMentionDraft('До'),target),prefixed=changeCommentMentionBody(draft,'Ввод '+draft.body);
 expect(ids(prefixed)).toEqual([target.user_id]);
 expect(ids(changeCommentMentionBody(prefixed,prefixed.body.replace(target.display_name,'Другое имя')))).toEqual([target.user_id]);
 expect(ids(changeCommentMentionBody(draft,'**'+draft.body+'**'))).toEqual([target.user_id]);
});

it('a selection inside an unfinished code fence cannot create hidden notification intent',()=>{
 const draft=addCommentMention(newCommentMentionDraft('```markdown\nКод'),target);expect(ids(draft)).toEqual([]);
});
