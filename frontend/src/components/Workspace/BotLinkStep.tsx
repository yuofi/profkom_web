import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { botLinkApi } from "../../utils/api/botLink.api";
import type { BotLinkCode, BotLinkMe, BotLinkState } from "../../utils/api/contract";
import { normalizeApiError } from "../../utils/api/request";
import { userMessage } from "../../utils/api/messages";
import { copyText } from "../../utils/clipboard";
import { displayTime } from "../../utils/dates";
import { useSession } from "../../utils/session";
import { Card, ErrorState, Loading } from "./WorkspaceUI";
import { botLinkKey, botLinkPollInterval, groupCode } from "./botLink";
import s from "./Workspace.module.css";
import b from "./BotLinkStep.module.css";

const TOKEN_HINT = "Бот попросит токен в личных сообщениях. Если этот диалог закрыт, нажмите в меню бота «🔑 Получить токен».";
const STATES: Record<BotLinkState, { status: string; hint?: string }> = {
  none: { status: "Бот не привязан.", hint: "Получите код и отправьте его боту ВКонтакте. Бот сам подтвердит привязку, страница обновится." },
  ok: { status: "Бот привязан." },
  messages_denied: { status: "Бот привязан, но сообщения от сообщества запрещены.", hint: "Откройте сообщество бота и нажмите «Разрешить сообщения»." },
  token_missing: { status: "Бот привязан, но у него нет вашего токена.", hint: TOKEN_HINT },
  token_invalid: { status: "Бот привязан, но ваш токен больше не работает.", hint: TOKEN_HINT },
};

/** A code issued here, with what the link was at that moment: when the link changes and the
 *  server no longer keeps an unused code, the bot has used it. */
interface Issued { code: BotLinkCode; linkedAt: string | null; vk: number | null; state: BotLinkState | null }
const used = (issued: Issued, me: BotLinkMe | undefined) =>
  !!me && !me.code_expires_at && (me.linked_at !== issued.linkedAt || me.vk_user_id !== issued.vk || me.state !== issued.state);

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * The VK link through HereBot (BOT_API.md, «Привязка VK»): the state in plain words, a
 * one-time code with the bot's link and command, and a poll of GET /bot-link/me every 3 s
 * while it waits. Nothing while the integration is off (`session.bot_link` null).
 */
export function BotLinkStep({ id, lead, linkedNote, frame = "card" }: {
  id?: string;
  /** A line under the title: why the step is here. */
  lead?: ReactNode;
  /** A line under the state while the link works (`ok`): what it gives on this page. */
  linkedNote?: ReactNode;
  /** `plain`: inside the host's own card (the gate page). */
  frame?: "card" | "plain";
}) {
  const { session } = useSession();
  const client = useQueryClient();
  const sessionLink = session?.bot_link ?? null;
  const [issued, setIssued] = useState<Issued | null>(null);
  const [now, setNow] = useState(Date.now);
  const [copied, setCopied] = useState<"" | "done" | "manual">("");
  const me = useQuery({
    queryKey: botLinkKey,
    queryFn: botLinkApi.me,
    enabled: !!sessionLink,
    staleTime: 0,
    // Back from the VK tab: read it at once instead of at the next tick.
    refetchOnWindowFocus: true,
    refetchInterval: (query) => botLinkPollInterval(query.state.data, issued && !used(issued, query.state.data) ? issued.code.expires_at : null),
    refetchIntervalInBackground: false,
  });
  const data = me.data;
  const shown = issued && !used(issued, data) ? issued.code : null;
  const expired = !!shown && Date.parse(shown.expires_at) <= now;
  // A changed link or blocking reaches the session (the gate, the banner) and the application.
  const sessionState = sessionLink?.state, sessionBlocked = sessionLink?.blocked;
  const state = data?.enabled ? data.state : null, blocked = data?.enabled ? data.blocked : null;
  useEffect(() => {
    if (!state || !sessionState || (state === sessionState && blocked === sessionBlocked)) return;
    void client.invalidateQueries({ queryKey: ["session"] });
    void client.invalidateQueries({ queryKey: ["registrations", "me"] });
  }, [client, state, blocked, sessionState, sessionBlocked]);
  // «Код истёк» appears on time, without waiting for another answer; so does the end of a
  // code issued earlier (in another tab or before a reload).
  const expiry = shown?.expires_at ?? data?.code_expires_at ?? null;
  useEffect(() => {
    if (!expiry) return;
    const left = Date.parse(expiry) - Date.now();
    if (!(left > 0)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(left + 50, 3_600_000));
    return () => window.clearTimeout(timer);
  }, [expiry]);
  const create = useMutation({
    mutationFn: botLinkApi.createCode,
    onSuccess: async (next) => {
      const current = client.getQueryData<BotLinkMe>(botLinkKey);
      // An older poll in flight must not hide the new code.
      await client.cancelQueries({ queryKey: botLinkKey });
      client.setQueryData<BotLinkMe>(botLinkKey, (old) => old && { ...old, code_expires_at: next.expires_at });
      setIssued({ code: next, linkedAt: current?.linked_at ?? null, vk: current?.vk_user_id ?? null, state: current?.state ?? null });
      setNow(Date.now());setCopied("");
    },
  });
  if (!sessionLink) return null;
  // Off on the server (or an older server without the route): the step is not there.
  if (data && !data.enabled) return null;
  if (!data && me.error && normalizeApiError(me.error).status === 404) return null;

  const request = (label: string, primary: boolean) => (
    <button type="button" className={`${s.button} ${primary ? s.primary : ""}`} disabled={create.isPending} aria-busy={create.isPending || undefined} onClick={() => create.mutate()}>
      {create.isPending ? "Получаем код…" : label}
    </button>
  );
  const openBot = (href: string | null | undefined, primary = false) => href
    ? <a className={`${s.linkButton} ${primary ? s.primary : ""}`} href={href} {...external}>Открыть бота</a>
    : null;
  let body: ReactNode;
  if (me.isLoading) body = <Loading />;
  else if (!data) body = <ErrorState error={me.error} retry={() => { void me.refetch(); }} />;
  else {
    const linkState = data.state ?? "none", text = STATES[linkState];
    const linked = linkState !== "none";
    const waiting = !shown && !!data.code_expires_at && Date.parse(data.code_expires_at) > now;
    body = <>
      <p role="status" className={b.status}>
        {text.status}
        {linked && data.vk_user_id !== null && <> Страница ВКонтакте: id{data.vk_user_id}.</>}
      </p>
      {linkState === "ok" && linkedNote}
      {text.hint && !shown && (linkState === "none" ? <p>{text.hint}</p> : <div className={`${s.note} ${b.hint}`}><p>{text.hint}</p>{openBot(data.bot_url)}</div>)}
      {shown && !expired && <div className={b.panel}>
        <p className={s.muted}>Ваш код</p>
        <p className={b.code}>{groupCode(shown.code)}</p>
        {shown.link_url
          ? <p>Откройте бота и нажмите «Начать»: код уйдёт сам.</p>
          : <p>Отправьте боту ВКонтакте команду ниже.</p>}
        {openBot(shown.link_url, true)}
        <p>{shown.link_url ? "Если бот не ответил, отправьте ему команду:" : "Команда:"}</p>
        <div className={b.command}>
          <code>{shown.command}</code>
          <button type="button" className={s.button} onClick={async () => setCopied((await copyText(shown.command)) ? "done" : "manual")}>Скопировать</button>
        </div>
        {copied === "done" && <p role="status" className={s.muted}>Команда скопирована.</p>}
        {copied === "manual" && <label className={s.field}>Скопируйте команду вручную<input readOnly value={shown.command} autoFocus onFocus={(event) => event.currentTarget.select()} /></label>}
        <p className={s.muted}>Код действует до {displayTime(shown.expires_at)}. Ждём ответа бота…</p>
      </div>}
      {shown && expired && <><p role="status">Код истёк — получите новый.</p>{request("Получить новый код", true)}</>}
      {waiting && <><p className={s.muted}>Код уже выдан и действует до {displayTime(data.code_expires_at!)}. Если он потерян, получите новый.</p>{request("Получить новый код", false)}</>}
      {!shown && !waiting && (linked ? request("Привязать заново", false) : request("Получить код", true))}
      {create.error && <p role="alert" className={s.error}>{userMessage(create.error)}</p>}
      {me.error && <p role="status" className={s.muted}>{userMessage(me.error)}{botLinkPollInterval(data, shown?.expires_at, now) !== false && " Проверим снова через несколько секунд."}</p>}
    </>;
  }
  if (frame === "plain") return <section id={id} aria-label="Бот ВКонтакте" className={b.step}>{lead}{body}</section>;
  return <Card id={id} title="Бот ВКонтакте">{lead}{body}</Card>;
}
