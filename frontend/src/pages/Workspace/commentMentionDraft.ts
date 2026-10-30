import type { UserRef } from "../../utils/api/contract";
import { getContactRoute } from "../../utils/routes";

interface PendingMention { user: UserRef; start: number; end: number; token: string }
export interface CommentMentionDraft { body: string; pending: PendingMention[] }
export const newCommentMentionDraft = (body = ""): CommentMentionDraft => ({ body, pending: [] });
const localLink = /(?<!!|\\)\[(?:\\.|[^\]\\\n])*\]\(\/contacts\/([1-9][0-9]*)\)/g;

/** A conservative display subset; typed links never create notification intent. */
function visibleProfiles(body: string): {id:number;start:number;end:number}[] {
  const hide=(source:string)=>source.replace(/[^\n]/g," ");
  let fence: string | null = null;
  const prose: string[] = [];
  for (const line of body.split(/(?<=\n)/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
      prose.push(hide(line));continue;
    }
    if (marker) { fence = marker[1];prose.push(hide(line));continue; }
    if (/^(?: {4}|\t)/.test(line)) {prose.push(hide(line));continue;}
    prose.push(line);
  }
  const source = prose.join("").replace(/(`+)[\s\S]*?\1(?!`)/g,hide);
  return [...source.matchAll(localLink)].flatMap(match=>Number.isSafeInteger(Number(match[1]))?[{id:Number(match[1]),start:match.index,end:match.index+match[0].length}]:[]);
}

/** Track the actual inserted range, so deleting a token cannot notify through another typed link. */
export function changeCommentMentionBody(draft: CommentMentionDraft, body: string): CommentMentionDraft {
  if (body === draft.body) return draft;
  let first = 0, tail = 0;
  while (first < draft.body.length && first < body.length && draft.body[first] === body[first]) first++;
  while (tail < draft.body.length - first && tail < body.length - first && draft.body[draft.body.length - 1 - tail] === body[body.length - 1 - tail]) tail++;
  const previousEnd = draft.body.length - tail, delta = body.length - draft.body.length, visible = visibleProfiles(body);
  const pending = draft.pending.flatMap(item => {
    if (item.user.user_id === null) return [];
    let start = item.start, end = item.end;
    if (previousEnd <= start) { start += delta;end += delta; }
    else if (first >= end) { /* An edit after this token does not change its identity. */ }
    else if (first >= start && previousEnd <= end) end += delta;
    else {
      // Whole-paragraph formatting may surround an unchanged token. Preserve a
      // unique occurrence, never guess between identical old/manual links.
      const oldIndex=draft.body.indexOf(item.token),nextIndex=body.indexOf(item.token);
      if (oldIndex!==item.start || draft.body.indexOf(item.token,oldIndex+1)!==-1 || nextIndex<0 || body.indexOf(item.token,nextIndex+1)!==-1) return [];
      start=nextIndex;end=start+item.token.length;
    }
    const token = body.slice(start, end), match = [...token.matchAll(localLink)];
    return visible.some(link=>link.id===item.user.user_id&&link.start===start&&link.end===end) && match.length === 1 && match[0].index === 0 && match[0][0] === token && Number(match[0][1]) === item.user.user_id
      ? [{ ...item, start, end, token }] : [];
  });
  return { body, pending };
}

export function addCommentMention(draft: CommentMentionDraft, user: UserRef): CommentMentionDraft {
  if (user.user_id === null || draft.pending.some(item => item.user.user_id === user.user_id)) return draft;
  const token = `[${user.display_name.replace(/[[\]\\]/g,"\\$&")}](${getContactRoute(user.user_id)})`;
  const prefix = draft.body && !draft.body.endsWith(" ") ? " " : "", start = draft.body.length + prefix.length;
  const body=draft.body + prefix + token + " ",end=start+token.length;
  return { body, pending: visibleProfiles(body).some(link=>link.id===user.user_id&&link.start===start&&link.end===end)?[...draft.pending,{user,start,end,token}]:draft.pending };
}

export function keepCommentMentions(draft: CommentMentionDraft, userIds: number[]): CommentMentionDraft {
  // Remove only owned inserted ranges; identical manually typed or old comment links survive.
  let next = draft;
  for (const item of [...draft.pending].sort((a,b) => b.start-a.start)) {
    if (item.user.user_id !== null && userIds.includes(item.user.user_id)) continue;
    if (next.body.slice(item.start,item.end) === item.token) next = changeCommentMentionBody(next,next.body.slice(0,item.start)+next.body.slice(item.end));
    next = {...next,pending:next.pending.filter(value => value.user.user_id !== item.user.user_id)};
  }
  return next;
}

export function commentMentionUsers(draft: CommentMentionDraft, previous: UserRef[] = []): UserRef[] {
  const visible = new Set(visibleProfiles(draft.body).map(link=>link.id)), result = new Map<number, UserRef>();
  for (const user of [...previous, ...draft.pending.map(item => item.user)])
    if (user.user_id !== null && visible.has(user.user_id)) result.set(user.user_id,user);
  return [...result.values()];
}
