import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UserChip } from "../../components/Workspace/UserChip";
import { Badge, Card, DeniedPage, Empty, ErrorDetail, Loading, Page, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { useUnsavedChanges } from "../../components/Workspace/unsavedChangesHooks";
import { number } from "../../components/Workspace/formValues";
import { broadcastKeys, broadcastsApi } from "../../utils/api/broadcasts.api";
import type { Broadcast, BroadcastCounts, Page as ListPage } from "../../utils/api/contract";
import { directoryApi } from "../../utils/api/directory.api";
import { ERROR_TEXTS, fieldMessage, userMessage } from "../../utils/api/messages";
import { canRetainData, normalizeApiError } from "../../utils/api/request";
import { createClientId } from "../../utils/clientId";
import { displayDate, shortDate } from "../../utils/dates";
import { getBroadcastRoute, getBroadcastsRoute } from "../../utils/routes";
import { can, useSession } from "../../utils/session";
import {
  BROADCAST_MAX, audienceHint, broadcastBadge, broadcastLength, broadcastPollInterval, excerpt, pausedBroadcastText,
  pausedComposeText, progressText, sendQuestion,
} from "./broadcastView";
import s from "../../components/Workspace/Workspace.module.css";
import b from "./BroadcastPages.module.css";

const isOff = (error: unknown) => {
  const e = normalizeApiError(error);
  return e.status === 404 && e.code === "bot_api_disabled";
};

/** The text of a failed send. The draft keeps its key, so a repeat never makes a second
 *  broadcast (GL-07); the key spent on an earlier text is the one exception. */
function sendFailure(error: unknown) {
  const e = normalizeApiError(error);
  if (e.status === 409 && e.code === "duplicate_request_key")
    return "Рассылка из этого черновика уже отправлена с прежним текстом — она в списке ниже. Чтобы отправить новый текст, нажмите «Отправить» ещё раз.";
  if (e.code === "bot_api_disabled") return "Связь с ботом ВКонтакте выключена: рассылку сейчас не отправить.";
  if (canRetainData(e) && e.code !== "client_error") return `${userMessage(e)} Если повторить отправку, вторая рассылка не появится.`;
  return userMessage(e);
}

function BroadcastCompose() {
  const client = useQueryClient();
  const audience = useQuery({ queryKey: broadcastKeys.audience, queryFn: broadcastsApi.audience });
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false), [sending, setSending] = useState(false), [sent, setSent] = useState(false);
  const [invalid, setInvalid] = useState(""), [failure, setFailure] = useState<{ error: unknown; message: string } | null>(null);
  // One key per draft: a repeat after a lost answer, even with an edited text, never makes a
  // second broadcast. A sent draft starts a new one with a new key.
  const key = useRef<string | null>(null);
  const answer = useRef<HTMLButtonElement>(null), outcome = useRef<HTMLParagraphElement>(null);
  const [settled, setSettled] = useState(0);
  const id = useId();
  const length = broadcastLength(text), over = length - BROADCAST_MAX;
  const off = isOff(audience.error);
  // Sending needs the counts for the question and at least one VK recipient (else 409).
  const ready = !!audience.data && !off && audience.data.reachable > 0;
  // The fresh counts have no VK recipient (or the integration went off): no question then.
  if (asking && !ready && !audience.isFetching) setAsking(false);
  useUnsavedChanges({ dirty: text.trim() !== "", busy: sending, label: "Новая рассылка", discard: () => setText("") });
  useEffect(() => { if (asking) answer.current?.focus(); }, [asking]);
  // The confirm button goes away with the answer: the focus moves to the outcome.
  useEffect(() => { if (settled) outcome.current?.focus(); }, [settled]);

  const edit = (value: string) => { setText(value);setAsking(false);setSent(false);setInvalid("");setFailure(null); };
  const ask = (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSent(false);setFailure(null);
    if (!length) { setInvalid("Напишите текст рассылки.");return; }
    if (over > 0) { setInvalid(`Текст длиннее ${BROADCAST_MAX} символов. Сократите его на ${over}.`);return; }
    setInvalid("");setAsking(true);
    // The question names the current counts.
    void audience.refetch();
  };
  const send = async () => {
    if (sending) return;
    setSending(true);setFailure(null);
    try {
      key.current ??= createClientId();
      await broadcastsApi.create({ text: text.trim(), idempotency_key: key.current });
      key.current = null;
      setText("");setAsking(false);setSent(true);
      void client.invalidateQueries({ queryKey: broadcastKeys.list });
      void client.invalidateQueries({ queryKey: broadcastKeys.audience });
    } catch (error) {
      const e = normalizeApiError(error);
      setAsking(false);
      if (e.status === 409 && e.code === "duplicate_request_key") key.current = null;
      // A lost answer may still have sent it; a spent key surely has.
      if (canRetainData(e) || e.code === "duplicate_request_key") void client.invalidateQueries({ queryKey: broadcastKeys.list });
      if (e.code === "broadcast_no_recipients" || e.code === "bot_api_disabled") void client.invalidateQueries({ queryKey: broadcastKeys.audience });
      const refused = Array.isArray(e.fields.errors)
        ? (e.fields.errors as { loc?: unknown[] }[]).find((item) => item?.loc?.at(-1) === "text")
        : e.fields.text;
      if (refused) setInvalid(fieldMessage(refused));
      setFailure({ error, message: sendFailure(error) });
    } finally {
      setSending(false);setSettled((count) => count + 1);
    }
  };

  let body;
  if (audience.isLoading) body = <Loading />;
  else body = <>
    {off && <div className={s.note}><p>Связь с ботом ВКонтакте выключена, поэтому новую рассылку сейчас не отправить. Отправленные рассылки остаются на сайте.</p></div>}
    {audience.error && !off && <QueryState loading={false} error={audience.error} retry={() => { void audience.refetch(); }}>{null}</QueryState>}
    {/* A draft typed before the integration went off stays on screen. */}
    {(!off || text) && <form className={`${s.form} ${b.compose}`} noValidate onSubmit={ask}>
      <fieldset className={s.formFields} disabled={sending}>
        <div className={s.columns}>
          <div className={s.field}>
            <label htmlFor={`${id}-text`}>Текст рассылки</label>
            <textarea id={`${id}-text`} name="text" rows={8} value={text} required
              aria-invalid={!!invalid || over > 0 || undefined}
              aria-describedby={`${id}-count${invalid ? ` ${id}-error` : ""}`}
              placeholder="Без оформления и вложений: VK покажет текст как есть, с переносами строк."
              onChange={(event) => edit(event.target.value)} />
            <small id={`${id}-count`} className={over > 0 ? s.fieldError : s.muted}>
              Символов: {length} из {BROADCAST_MAX}{over > 0 && ` — сократите на ${over}`}
            </small>
            {invalid && <span id={`${id}-error`} className={s.fieldError}>{invalid}</span>}
          </div>
          <section className={b.preview} aria-label="Предпросмотр в VK">
            <span className={s.muted}>Так сообщение будет выглядеть в VK</span>
            <div className={s.previewBox}>
              {text.trim() ? <p className={b.text}>{text.trim()}</p> : <p className={s.muted}>Здесь появится текст рассылки.</p>}
            </div>
          </section>
        </div>
        {audience.data && !off && <p className={s.muted}>{audienceHint(audience.data)}</p>}
        {audience.data?.paused && !off && <div role="status" className={s.note}><p>{pausedComposeText(audience.data.paused)}</p></div>}
        {asking && ready && <div role="alert" className={s.warning}>
          <p>{sendQuestion(audience.data!)}</p>
          <div className={s.row}>
            <button ref={answer} type="button" className={s.button} onClick={() => void send()}>{sending ? "Отправляем…" : "Да, отправить"}</button>
            <button type="button" className={s.button} onClick={() => setAsking(false)}>Отмена</button>
          </div>
        </div>}
        {failure && <>
          <p ref={outcome} tabIndex={-1} role="alert" className={s.error}>{failure.message}</p>
          <ErrorDetail error={failure.error} />
        </>}
        {sent && <p ref={outcome} tabIndex={-1} role="status" className={s.success}>Рассылка отправлена. Ход отправки — в списке ниже.</p>}
        <div>
          <button type="submit" className={`${s.button} ${s.primary}`} disabled={!ready || asking}>
            {sending ? "Отправляем…" : "Отправить"}
          </button>
        </div>
      </fieldset>
    </form>}
  </>;
  return <Card title="Новая рассылка">{body}</Card>;
}

/** «Отменить» of a sending broadcast: what has not gone yet stays unsent. A broadcast that
 *  ended meanwhile keeps the refusal on screen beside its new state. */
function CancelBroadcast({ item, className }: { item: Broadcast; className?: string }) {
  const client = useQueryClient();
  const [ended, setEnded] = useState(false);
  const id = item.broadcast_id, pending = item.counts?.pending ?? 0;
  if (!item.counts || (item.state !== "sending" && !ended)) return null;
  return (
    <div className={className}>
      <ActionForm fields={[]} variant="danger" submitLabel="Отменить" submitTitle="Отменить рассылку" successMessage="Рассылка отменена."
        disabled={item.state !== "sending"}
        confirm={{
          label: "Да, отменить рассылку",
          text: `Отменить рассылку? ${pending ? `Ещё не отправленные сообщения не уйдут: ${pending}. ` : ""}Уже отправленные останутся, уведомления на сайте тоже.`,
        }}
        onSubmit={async () => {
          let next: Broadcast;
          try { next = await broadcastsApi.cancel(id); }
          catch (error) {
            // Finished or cancelled meanwhile: show what it is now.
            if (normalizeApiError(error).code === "broadcast_not_sending") setEnded(true);
            void client.invalidateQueries({ queryKey: broadcastKeys.list });
            void client.invalidateQueries({ queryKey: broadcastKeys.item(id) });
            throw error;
          }
          await client.cancelQueries({ queryKey: broadcastKeys.list });
          client.setQueryData(broadcastKeys.item(id), next);
          client.setQueryData<InfiniteData<ListPage<Broadcast>>>(broadcastKeys.list, (data) => data && {
            ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((row) => row.broadcast_id === id ? next : row) })),
          });
        }} />
    </div>
  );
}

function BroadcastHistory() {
  const query = useInfiniteQuery({
    queryKey: broadcastKeys.list,
    queryFn: ({ pageParam, signal }) => broadcastsApi.list(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: (current) => broadcastPollInterval(current.state.data?.pages.flatMap((page) => page.items)),
    refetchIntervalInBackground: false,
  });
  // One row per broadcast, even if a new one shifted the pages between two reads.
  const items = [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.broadcast_id, item])).values()];
  const loadingMore = query.isFetchingNextPage;
  return (
    <Card title="Отправленные рассылки">
      <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => { void query.refetch(); }}>
        {items.length > 0 && <ul className={s.list}>
          {items.map((item) => (
            <li key={item.broadcast_id}>
              <RouteLink to={getBroadcastRoute(item.broadcast_id)}>{excerpt(item.text)}</RouteLink>
              <p>{item.author?.display_name ?? "Автор неизвестен"} · <time dateTime={item.created_at}>{shortDate(item.created_at)}</time></p>
              <Badge tone={broadcastBadge(item).tone}>{broadcastBadge(item).label}</Badge>
              {item.counts && <span className={s.muted}>{progressText(item.counts)}</span>}
              <CancelBroadcast item={item} className={b.rowAction} />
            </li>
          ))}
        </ul>}
        {query.hasNextPage && <button type="button" className={s.button} aria-disabled={loadingMore || undefined} aria-busy={loadingMore || undefined}
          onClick={() => { if (!loadingMore) void query.fetchNextPage(); }}>{loadingMore ? "Загружаем…" : "Показать ещё"}</button>}
        {query.data && !items.length && <Empty>Рассылок пока нет.</Empty>}
      </QueryState>
    </Card>
  );
}

const fullName = (p: { surname: string; name: string }) => `${p.surname} ${p.name}`;
/** The chair and deputies give the right to send to other members (BOT_API.md, stage 1 routes). */
function BroadcastSenders() {
  const client = useQueryClient();
  const senders = useQuery({ queryKey: broadcastKeys.senders, queryFn: broadcastsApi.senders });
  const people = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts });
  const current = new Set(senders.data?.items.map((person) => person.user_id));
  const choices = people.data
    ?.filter((person) => !current.has(person.user_id))
    .map((person) => ({ value: String(person.user_id), label: fullName(person), user: { user_id: person.user_id, display_name: fullName(person), avatar_url: person.photo_url ?? null } })) ?? [];
  const change = async (userId: number, sender: boolean) => {
    await broadcastsApi.setSender(userId, sender);
    await client.invalidateQueries({ queryKey: broadcastKeys.senders });
  };
  return (
    <Card title="Отправители">
      <p className={s.muted}>Председатель и замы отправляют рассылки всегда. Право отправлять можно дать любому участнику.</p>
      <QueryState loading={senders.isLoading} error={senders.error} keepDataOnError={!!senders.data} retry={() => { void senders.refetch(); }}>
        {!!senders.data?.items.length && <ul className={s.list}>
          {senders.data.items.map((person) => (
            <li key={person.user_id}>
              <div className={s.between}>
                <UserChip user={person} />
                <ActionForm fields={[]} variant="danger" submitLabel="Снять"
                  // A short word in the row; its full name says whose right it takes (D-05).
                  submitTitle={`Снять право отправлять рассылки: ${person.display_name}`}
                  onSubmit={async () => { await change(person.user_id!, false); }} />
              </div>
            </li>
          ))}
        </ul>}
        {senders.data && !senders.data.items.length && <Empty>Других отправителей пока нет.</Empty>}
        <ActionForm title="Добавить отправителя" resetOnSuccess submitLabel="Выдать право"
          fields={[{ name: "user", label: "Участник", type: "select", entity: "person", required: true, options: choices, loading: people.isLoading }]}
          onSubmit={async (values) => { await change(number(values, "user"), true); }} />
        {people.error && <QueryState loading={false} error={people.error}>{null}</QueryState>}
      </QueryState>
    </Card>
  );
}

/** /broadcasts: a new broadcast and the sent ones for senders, the senders for the chair and deputies. */
export function BroadcastsPage() {
  const { session } = useSession();
  const sends = can(session, "send_broadcast"), manages = can(session, "manage_broadcast_senders");
  // Also what stays after a refusal by the right: the session reread takes the forms away.
  if (!sends && !manages)
    return <Page title="Рассылки"><Empty>{ERROR_TEXTS.broadcast_send_forbidden}</Empty></Page>;
  return (
    <Page title="Рассылки" description="Рассылка уходит в личные сообщения бота ВКонтакте всем, у кого он подключён, и приходит каждому участнику уведомлением на сайте.">
      <div className={s.stack}>
        {sends && <BroadcastCompose />}
        {sends && <BroadcastHistory />}
        {manages && <BroadcastSenders />}
      </div>
    </Page>
  );
}

/** /broadcasts/:id: where the bell leads every member; senders also see how the sending goes. */
export function BroadcastPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { session } = useSession();
  const query = useQuery({
    queryKey: broadcastKeys.item(id),
    queryFn: () => broadcastsApi.get(id),
    refetchInterval: (current) => broadcastPollInterval([current.state.data]),
    refetchIntervalInBackground: false,
  });
  const back = can(session, "send_broadcast")
    ? { to: getBroadcastsRoute(), label: "Все рассылки" }
    : { to: "/notifications", label: "Все уведомления" };
  const item = query.data;
  if (!item && query.error && normalizeApiError(query.error).status === 404)
    return <DeniedPage title="Рассылка" back={back}>Рассылка не найдена.</DeniedPage>;
  return (
    // The section stamp leads back: to Рассылки for senders, to Уведомления for the others.
    <Page title="Рассылка">
      <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!item} retry={() => { void query.refetch(); }}>
        {item && <div className={s.stack}>
          <Card>
            <div className={s.row}>
              {item.author ? <UserChip user={item.author} /> : <span className={s.muted}>Автор неизвестен</span>}
              <time className={s.muted} dateTime={item.created_at}>{displayDate(item.created_at)}</time>
            </div>
            <p className={b.text}>{item.text}</p>
          </Card>
          {item.counts && <Card title="Отправка в VK">
            <div className={s.badges}><Badge tone={broadcastBadge(item).tone}>{broadcastBadge(item).label}</Badge></div>
            {item.paused && <div role="status" className={s.warning}><p>{pausedBroadcastText(item.paused)}</p></div>}
            <BroadcastCountsList counts={item.counts} />
            {item.state === "cancelled" && item.cancelled_at && <p className={s.muted}>Отменена {displayDate(item.cancelled_at)}.</p>}
            <CancelBroadcast item={item} />
          </Card>}
        </div>}
      </QueryState>
    </Page>
  );
}

function BroadcastCountsList({ counts }: { counts: BroadcastCounts }) {
  const rows: [string, number, boolean][] = [
    ["Получателей в VK", counts.total, true],
    ["Отправлено", counts.sent, true],
    ["Ждут отправки", counts.pending, counts.pending > 0],
    ["Запретили сообщения сообщества", counts.denied, counts.denied > 0],
    ["Не удалось отправить", counts.failed, counts.failed > 0],
    ["Не отправлено за сутки", counts.expired, counts.expired > 0],
    ["Отменено до отправки", counts.cancelled, counts.cancelled > 0],
  ];
  return (
    <dl className={b.counts}>
      {rows.filter(([, , shown]) => shown).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}
