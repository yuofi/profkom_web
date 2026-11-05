import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UserChip } from "../../components/Workspace/UserChip";
import { Badge, Card, Empty, ErrorDetail, ErrorState, Loading, Page, QueryState } from "../../components/Workspace/WorkspaceUI";
import { BOT_LINK_ANCHOR } from "../../components/Workspace/botLink";
import { number } from "../../components/Workspace/formValues";
import { botConsoleApi, botConsoleKeys } from "../../utils/api/botConsole.api";
import type { BotCommand, BotCommandInput, BotConsoleStatus, BotLogError } from "../../utils/api/contract";
import { directoryApi } from "../../utils/api/directory.api";
import { userMessage } from "../../utils/api/messages";
import { ApiError, canRetainData, normalizeApiError } from "../../utils/api/request";
import { requestKey, type RequestKey } from "../../utils/clientId";
import { copyText } from "../../utils/clipboard";
import { displayDate, shortDate } from "../../utils/dates";
import { getProfileSettingsRoute } from "../../utils/routes";
import { can, useSession } from "../../utils/session";
import {
  JOB_GOING_TEXT, LOG_LEVELS, LOG_LINES_DEFAULT, PAUSE_QUESTION, RESTART_LATE_TEXT, RESTART_WAIT_TEXT, SERVER_LATE_TEXT,
  SERVER_WAIT_TEXT, changelogFor, checkText, commandOpen, commandOutcome, commandPollInterval, commandStateNames,
  commandStateTones, commandTitle, componentRows, connection, counterRows, databaseName, jobGoing, jobOutcome, jobRows,
  lastReport, levelTone, logsArgs, longPollText, newerMajor, pauseText, queueText, remoteText, restartBackText,
  restartQuestion, restartWait, rollbackOffer, rollbackQuestion, runningVersion, serverWait, statusPollInterval, updateOffer,
  updateQuestion, updatesAllowed,
} from "./botConsoleView";
import { plural } from "./seasonAnalyticsView";
import s from "../../components/Workspace/Workspace.module.css";
import c from "./BotConsolePage.module.css";

type CommandRequest = Omit<BotCommandInput, "idempotency_key">;

/** Sends a command. The key stays while the same command is sent again (an answer was lost),
 *  so the server returns the command it already made instead of a second one (GL-07). */
async function createCommand(client: QueryClient, slot: RequestKey, input: CommandRequest) {
  try {
    const command = await botConsoleApi.create({ ...input, idempotency_key: requestKey(slot, input) } as BotCommandInput);
    slot.current = null;
    client.setQueryData(botConsoleKeys.command(command.command_id), command);
    void client.invalidateQueries({ queryKey: botConsoleKeys.commands });
    return command;
  } catch (error) {
    const e = normalizeApiError(error);
    if (e.code === "duplicate_request_key") slot.current = null;
    // The bot went away or the integration is off: the status says it at once.
    if (e.code === "bot_offline" || e.code === "bot_api_disabled") void client.invalidateQueries({ queryKey: botConsoleKeys.status });
    if (e.code === "bot_command_pending") void client.invalidateQueries({ queryKey: botConsoleKeys.commands });
    // A lost answer may still have made it: the history learns it, a repeat returns it.
    if (canRetainData(e) && e.code !== "client_error") {
      void client.invalidateQueries({ queryKey: botConsoleKeys.commands });
      throw new ApiError(`${userMessage(e)} Если повторить, второй команды не будет.`);
    }
    throw error;
  }
}

/** A command the reader waits for or opened: rereads every 2 s until the bot finishes it. Each
 *  change rereads the history, the end also the status (a restart, an update changes the bot). */
function useCommand(id: string | null) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: botConsoleKeys.command(id ?? ""),
    queryFn: ({ signal }) => botConsoleApi.command(id!, signal),
    enabled: id !== null,
    refetchInterval: (current) => commandPollInterval(current.state.data),
    refetchIntervalInBackground: false,
  });
  const state = query.data?.state, open = commandOpen(query.data);
  const seen = useRef(state);
  useEffect(() => {
    const before = seen.current;
    seen.current = state;
    if (!before || !state || before === state) return;
    void client.invalidateQueries({ queryKey: botConsoleKeys.commands });
    if (!open) void client.invalidateQueries({ queryKey: botConsoleKeys.status });
  }, [client, state, open]);
  return query;
}

/** The log as the bot sent it, scrolled in place, with a copy button. */
function CommandOutput({ text }: { text: string }) {
  const [copied, setCopied] = useState<"" | "done" | "manual">("");
  const block = useRef<HTMLPreElement>(null);
  if (!text) return <p className={s.muted}>Подходящих записей нет.</p>;
  const copy = async () => {
    const done = await copyText(text);
    setCopied(done ? "done" : "manual");
    // The browser refused: the text is selected for a manual copy.
    if (!done && block.current) window.getSelection()?.selectAllChildren(block.current);
  };
  const lines = text.split("\n").length;
  return (
    <div className={c.block}>
      <div className={s.between}>
        <span className={s.muted}>{lines} {plural(lines, "строка", "строки", "строк")}</span>
        <button type="button" className={s.button} onClick={() => void copy()}>Скопировать</button>
      </div>
      <pre ref={block} className={c.log} tabIndex={0} aria-label="Вывод журнала">{text}</pre>
      {copied === "done" && <p role="status" className={s.muted}>Вывод скопирован.</p>}
      {copied === "manual" && <p role="status" className={s.muted}>Браузер не дал скопировать: текст выделен, скопируйте его вручную.</p>}
    </div>
  );
}

/** A turning ring: the console waits for the bot or the server (owner, 2026-11-05). */
const Spinner = () => <span className={c.spinner} aria-hidden="true" />;
function Waiting({ children }: { children: ReactNode }) {
  return <p role="status" className={c.waiting}><Spinner />{children}</p>;
}

/** What became of a command: its state, the bot's words and, for the log, the output; then
 *  what the card waits for after it (`children`). */
function CommandResult({ query, children }: { query: ReturnType<typeof useCommand>; children?: ReactNode }) {
  const command = query.data;
  if (!command) return query.error ? <ErrorState error={query.error} retry={() => { void query.refetch(); }} /> : <Loading />;
  const open = commandOpen(command);
  return (
    <div className={c.result} aria-busy={open || undefined}>
      <div className={s.row} role="status">
        <Badge tone={commandStateTones[command.state]}>{commandStateNames[command.state] ?? command.state}</Badge>
        {open && <Spinner />}
        <span>{commandOutcome(command)}</span>
      </div>
      {command.message && <p>{command.message}</p>}
      {command.code && command.state === "failed" && <p className={s.muted}>Причина: <code>{command.code}</code></p>}
      {command.output !== null && <CommandOutput text={command.output} />}
      {query.error && open && <p className={s.muted}>{userMessage(query.error)} Проверим снова через пару секунд.</p>}
      {children}
    </div>
  );
}

/** One command behind a button, with the question first when it stops the bot or the sending. */
function CommandButton({ input, label, question, answer, variant = "quiet", disabled, onCreated }: {
  input: CommandRequest;
  label: string;
  question?: ReactNode;
  answer?: string;
  variant?: "primary" | "quiet" | "danger";
  disabled: boolean;
  onCreated: (command: BotCommand) => void;
}) {
  const client = useQueryClient();
  const slot = useRef<RequestKey["current"]>(null);
  return (
    <ActionForm fields={[]} submitLabel={label} variant={variant} disabled={disabled} successMessage=""
      confirm={question && answer ? { text: question, label: answer } : undefined}
      onSubmit={async () => { onCreated(await createCommand(client, slot, input)); }} />
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className={c.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function StatusCard({ status, now }: { status: BotConsoleStatus; now: number }) {
  const link = connection(status), heartbeat = status.heartbeat;
  return (
    <Card title="Состояние">
      <div className={s.row}>
        <Badge tone={link.tone}>{link.label}</Badge>
        <span className={s.muted}>
          {lastReport(status, now)}
          {status.last_seen_at && <> · <time dateTime={status.last_seen_at}>{shortDate(status.last_seen_at, now)}</time></>}
        </span>
      </div>
      {link.note && <p>{link.note}</p>}
      {status.queue && <p>{queueText(status.queue)}</p>}
      {heartbeat ? <div className={s.columns}>
        <div className={c.block}>
          <Facts rows={[
            ["Версия", <>{heartbeat.version || "—"}{heartbeat.commit && <> · коммит <code>{heartbeat.commit}</code></>}</>],
            ["Запущен", <time dateTime={heartbeat.started_at}>{displayDate(heartbeat.started_at)}</time>],
            ["Long Poll", longPollText(heartbeat.longpoll_connected)],
            ["База данных", databaseName(heartbeat.database)],
          ]} />
          <h3>Отметки здоровья</h3>
          <p className={s.muted}>Сколько прошло с последней отметки компонента, на момент отчёта.</p>
          {componentRows(heartbeat).length ? <Facts rows={componentRows(heartbeat)} /> : <p className={s.muted}>Бот не прислал отметок.</p>}
        </div>
        <div className={c.block}>
          <h3>Счётчики</h3>
          {counterRows(heartbeat.counters).length ? <Facts rows={counterRows(heartbeat.counters)} /> : <p className={s.muted}>Бот не прислал счётчиков.</p>}
          <p className={s.muted}>Уведомления и рассылки — с запуска бота, остальное — из его базы.</p>
        </div>
      </div> : <p className={s.muted}>Бот ещё не присылал сведений о себе.</p>}
    </Card>
  );
}

/** The update channel (BOT_API.md, «Обновления в heartbeat») and, for operators, its commands. */
function UpdatesCard({ status, operates, now }: { status: BotConsoleStatus; operates: boolean; now: number }) {
  const { session } = useSession();
  const [last, setLast] = useState<string | null>(null);
  const command = useCommand(last);
  const heartbeat = status.heartbeat, updates = heartbeat?.updates, check = updates?.check;
  const running = runningVersion(heartbeat), update = updateOffer(heartbeat), rollback = rollbackOffer(heartbeat);
  const changelog = update ? changelogFor(updates, update) : null, major = newerMajor(heartbeat);
  // The server's requests name the VK of the person who asks (bot_console_vk_required).
  const noVk = session?.bot_link?.state === "none";
  const waiting = commandOpen(command.data);
  // After «Обновить» or «Откатить» the server works on: its job comes with the bot's reports.
  const server = serverWait(command.data, updates?.job, now);
  const disabled = !status.enabled || !status.online;
  return (
    <Card title="Обновления">
      {!updates ? <p className={s.muted}>Бот этой версии не сообщает, что с обновлениями.</p> : <>
        <Facts rows={[
          ["Работает", running || "—"],
          ["Доступна", check?.status === "available" && check.target ? check.target : "—"],
          ["Проверено", check?.checked_at ? <time dateTime={check.checked_at}>{displayDate(check.checked_at)}</time> : "—"],
        ]} />
        <p>{checkText(heartbeat)}</p>
        {major && <p className={s.muted}>Вышла и новая основная версия {major}: её ставит оператор сервера.</p>}
        <p className={s.muted}>{remoteText(updates)}</p>
        {update && changelog && <section className={c.block} aria-label={`Что нового в ${update}`}>
          <h3>Что нового в {update}</h3>
          <p className={c.changelog}>{changelog.text}</p>
          {changelog.truncated && <p className={s.muted}>Дальше — в CHANGELOG.md.</p>}
        </section>}
        {updates.job && <div className={c.block}>
          <h3>Последняя задача на сервере</h3>
          {jobGoing(updates.job, now) && !server?.waiting && <Waiting>{JOB_GOING_TEXT}</Waiting>}
          <Facts rows={jobRows(updates.job)} />
        </div>}
        {operates && updatesAllowed(updates) && <div className={c.block}>
          {noVk && <p className={s.muted}>
            Проверять и ставить обновления из консоли можно с привязанным VK: сервер записывает, кто попросил.{" "}
            <Link to={`${getProfileSettingsRoute()}#${BOT_LINK_ANCHOR}`}>Привязать VK</Link>
          </p>}
          {update && <CommandButton key={`update-${update}`} input={{ kind: "update", args: { version: update } }} label={`Обновить до ${update}`}
            variant="primary" disabled={disabled || waiting} question={updateQuestion(running, update)} answer="Да, обновить"
            onCreated={(created) => setLast(created.command_id)} />}
          {rollback && <CommandButton key={`rollback-${rollback}`} input={{ kind: "rollback", args: { version: rollback } }} label={`Откатить на ${rollback}`}
            variant="danger" disabled={disabled || waiting} question={rollbackQuestion(running, rollback)} answer="Да, откатить"
            onCreated={(created) => setLast(created.command_id)} />}
          <CommandButton input={{ kind: "updates_check", args: {} }} label="Проверить обновления" disabled={disabled || waiting}
            onCreated={(created) => setLast(created.command_id)} />
        </div>}
      </>}
      {last && <CommandResult query={command}>
        {server?.waiting && <Waiting>{SERVER_WAIT_TEXT}</Waiting>}
        {server?.late && <p className={s.muted}>{SERVER_LATE_TEXT}</p>}
        {server?.job && !server.waiting && !server.late && <p role="status">{jobOutcome(server.job)}</p>}
      </CommandResult>}
    </Card>
  );
}

function PauseControl({ status }: { status: BotConsoleStatus }) {
  const client = useQueryClient();
  const set = async (paused: boolean) => {
    try {
      const next = await botConsoleApi.pause(paused);
      // A read that left before the change must not bring the old state back.
      await client.cancelQueries({ queryKey: botConsoleKeys.status });
      client.setQueryData(botConsoleKeys.status, next);
    } catch (error) {
      void client.invalidateQueries({ queryKey: botConsoleKeys.status });
      throw error;
    }
  };
  return status.paused
    ? <ActionForm key="resume" fields={[]} submitLabel="Возобновить отправку" successMessage="" disabled={!status.enabled}
      onSubmit={() => set(false)} />
    : <ActionForm key="pause" fields={[]} variant="danger" submitLabel="Приостановить отправку" successMessage="" disabled={!status.enabled}
      confirm={{ text: PAUSE_QUESTION, label: "Да, приостановить" }} onSubmit={() => set(true)} />;
}

function ControlCard({ status, now }: { status: BotConsoleStatus; now: number }) {
  const [last, setLast] = useState<string | null>(null);
  // The boot the restart stops: the bot is back once the status names another one.
  const [before, setBefore] = useState<string | null>(null);
  const command = useCommand(last);
  const reachable = status.enabled && status.online;
  const restart = restartWait(command.data, before, status, now);
  return (
    <Card title="Управление">
      {status.enabled && !status.online && <p className={s.muted}>Бот не на связи: перезапуск и журнал до него не дойдут. Пауза работает и без него.</p>}
      <div className={c.block}>
        <h3>Отправка в VK</h3>
        <p className={s.muted}>{status.paused
          ? "Отправка приостановлена: уведомления и рассылки ждут в очереди."
          : "Уведомления и рассылки уходят в VK как обычно. Пауза их задержит, команды бот получает и на паузе."}</p>
        <PauseControl status={status} />
      </div>
      <div className={c.block}>
        <h3>Перезапуск</h3>
        <p className={s.muted}>Бот остановится штатно, и сервер поднимет его снова. Не чаще раза в 2 минуты.</p>
        <CommandButton input={{ kind: "restart", args: {} }} label="Перезапустить бота" variant="danger" disabled={!reachable || commandOpen(command.data)}
          question={restartQuestion()} answer="Да, перезапустить"
          onCreated={(created) => { setBefore(status.boot_id);setLast(created.command_id); }} />
        {last && <CommandResult query={command}>
          {restart && !restart.back && !restart.late && <Waiting>{RESTART_WAIT_TEXT}</Waiting>}
          {restart?.late && <p className={s.muted}>{RESTART_LATE_TEXT}</p>}
          {restart?.back && <p role="status">{restartBackText(status.heartbeat?.started_at)}</p>}
        </CommandResult>}
      </div>
    </Card>
  );
}

/** «Журнал»: the last records of herebot.log by a `logs` command, then its output. */
function LogsCard({ status }: { status: BotConsoleStatus }) {
  const client = useQueryClient();
  const id = useId();
  const [lines, setLines] = useState(String(LOG_LINES_DEFAULT)), [level, setLevel] = useState(""), [contains, setContains] = useState("");
  const [invalid, setInvalid] = useState<{ field: "lines" | "contains"; error: string } | null>(null);
  const [sending, setSending] = useState(false), [failure, setFailure] = useState<unknown>(null);
  const [last, setLast] = useState<string | null>(null);
  const command = useCommand(last);
  const slot = useRef<RequestKey["current"]>(null);
  const reachable = status.enabled && status.online, waiting = commandOpen(command.data);
  const edit = (apply: () => void) => { apply();setInvalid(null);setFailure(null); };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (sending || waiting) return;
    const parsed = logsArgs({ lines, level, contains });
    if (!parsed.args) { setInvalid({ field: parsed.field, error: parsed.error });return; }
    setInvalid(null);setFailure(null);setSending(true);
    try { setLast((await createCommand(client, slot, { kind: "logs", args: parsed.args })).command_id); }
    catch (error) { setFailure(error); }
    finally { setSending(false); }
  };
  const error = (field: "lines" | "contains") => invalid?.field === field ? `${id}-${field}-error` : undefined;
  return (
    <Card title="Журнал бота">
      <p className={s.muted}>Последние записи herebot.log: бот читает их по команде, сайт хранит вывод сутки.</p>
      <form className={s.form} noValidate onSubmit={(event) => void send(event)}>
        <fieldset className={`${s.formFields} ${s.compactFields}`} disabled={sending || !reachable}>
          <div className={`${s.field} ${s.compactField} ${s.compactStart}`}>
            <label htmlFor={`${id}-lines`}>Сколько записей</label>
            <input id={`${id}-lines`} name="lines" type="number" inputMode="numeric" min={1} max={2000} step={1} value={lines}
              aria-invalid={invalid?.field === "lines" || undefined} aria-describedby={error("lines")}
              onChange={(event) => edit(() => setLines(event.target.value))} />
            <small>От 1 до 2000.</small>
            {invalid?.field === "lines" && <span id={error("lines")} className={s.fieldError}>{invalid.error}</span>}
          </div>
          <div className={`${s.field} ${s.compactField}`}>
            <label htmlFor={`${id}-level`}>Уровень не ниже</label>
            <select id={`${id}-level`} name="level" value={level} onChange={(event) => edit(() => setLevel(event.target.value))}>
              <option value="">Любой</option>
              {LOG_LEVELS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <small>Этот уровень и выше.</small>
          </div>
          <div className={`${s.field} ${s.compactField}`}>
            <label htmlFor={`${id}-contains`}>Содержит</label>
            <input id={`${id}-contains`} name="contains" type="text" value={contains} placeholder="Например, timeout"
              aria-invalid={invalid?.field === "contains" || undefined} aria-describedby={error("contains")}
              onChange={(event) => edit(() => setContains(event.target.value))} />
            <small>Без учёта регистра.</small>
            {invalid?.field === "contains" && <span id={error("contains")} className={s.fieldError}>{invalid.error}</span>}
          </div>
          {!!failure && <div>
            <p role="alert" className={s.error}>{userMessage(failure)}</p>
            <ErrorDetail error={failure} />
          </div>}
          <div>
            <button type="submit" className={`${s.button} ${s.primary}`} disabled={waiting}>{sending ? "Запрашиваем…" : "Показать журнал"}</button>
          </div>
        </fieldset>
      </form>
      {last && <CommandResult query={command} />}
    </Card>
  );
}

function CommandRow({ item }: { item: BotCommand }) {
  const [open, setOpen] = useState(false);
  const opened = useCommand(open ? item.command_id : null);
  return (
    <li>
      <div className={c.entry}>
        <div className={c.head}>
          <strong>{commandTitle(item)}</strong>
          <span className={s.badges}>
            {commandOpen(item) && <Spinner />}
            <Badge tone={commandStateTones[item.state]}>{commandStateNames[item.state] ?? item.state}</Badge>
          </span>
        </div>
        <p className={s.muted}>
          {item.requested_by?.display_name ?? "Аккаунт удалён"} · <time dateTime={item.created_at}>{shortDate(item.created_at)}</time>
          {item.code && item.state === "failed" && <> · <code>{item.code}</code></>}
        </p>
        {item.message && <p>{item.message}</p>}
        {item.has_output && <div>
          <button type="button" className={s.button} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Скрыть вывод" : "Показать вывод"}
          </button>
        </div>}
        {open && (opened.data
          ? opened.data.output !== null ? <CommandOutput text={opened.data.output} /> : <p className={s.muted}>Вывода уже нет: сайт хранит его сутки.</p>
          : opened.error ? <ErrorState error={opened.error} retry={() => { void opened.refetch(); }} /> : <Loading />)}
      </div>
    </li>
  );
}

function CommandHistory() {
  const query = useInfiniteQuery({
    queryKey: botConsoleKeys.commands,
    queryFn: ({ pageParam, signal }) => botConsoleApi.commands(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  // One row per command, even if a new one shifted the pages between two reads.
  const items = [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.command_id, item])).values()];
  const loadingMore = query.isFetchingNextPage;
  return (
    <Card title="История команд">
      <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => { void query.refetch(); }}>
        {items.length > 0 && <ul className={s.list}>{items.map((item) => <CommandRow key={item.command_id} item={item} />)}</ul>}
        {query.hasNextPage && <button type="button" className={s.button} aria-disabled={loadingMore || undefined} aria-busy={loadingMore || undefined}
          onClick={() => { if (!loadingMore) void query.fetchNextPage(); }}>{loadingMore ? "Загружаем…" : "Показать ещё"}</button>}
        {query.data && !items.length && <Empty>Команд пока не было.</Empty>}
      </QueryState>
    </Card>
  );
}

function ErrorsCard({ errors }: { errors: BotLogError[] }) {
  return (
    <Card title="Ошибки в журнале бота">
      <p className={s.muted}>Записи уровня WARNING и выше, одинаковые — одной строкой. Сначала свежие.</p>
      {errors.length ? <ul className={s.list}>
        {errors.map((item) => (
          <li key={item.fingerprint}>
            <div className={c.entry}>
              <div className={c.head}>
                <span className={s.badges}><Badge tone={levelTone(item.level)}>{item.level}</Badge>{item.where && <code>{item.where}</code>}</span>
                <span className={s.muted}>{item.count} {plural(item.count, "раз", "раза", "раз")}</span>
              </div>
              <p>{item.message}</p>
              <p className={s.muted}>
                Последний раз — <time dateTime={item.last_at}>{shortDate(item.last_at)}</time>{item.logger && <> · {item.logger}</>}
              </p>
              {item.traceback && <details>
                <summary>Трассировка</summary>
                <pre className={c.log}>{item.traceback}</pre>
              </details>}
            </div>
          </li>
        ))}
      </ul> : <Empty>Ошибок в журнале бота нет.</Empty>}
    </Card>
  );
}

const fullName = (p: { surname: string; name: string }) => `${p.surname} ${p.name}`;
/** Everyone who sees the console sees them; only the IT master names and removes them. */
function Maintainers({ manages }: { manages: boolean }) {
  const client = useQueryClient();
  const maintainers = useQuery({ queryKey: botConsoleKeys.maintainers, queryFn: botConsoleApi.maintainers });
  const people = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts, enabled: manages });
  const current = new Set(maintainers.data?.items.map((person) => person.user_id));
  const choices = people.data
    ?.filter((person) => !current.has(person.user_id))
    .map((person) => ({ value: String(person.user_id), label: fullName(person), user: { user_id: person.user_id, display_name: fullName(person), avatar_url: person.photo_url ?? null } })) ?? [];
  const change = async (userId: number, maintainer: boolean) => {
    await botConsoleApi.setMaintainer(userId, maintainer);
    await client.invalidateQueries({ queryKey: botConsoleKeys.maintainers });
  };
  return (
    <Card title="Сопровождающие">
      <p className={s.muted}>{manages
        ? "Сопровождающие видят консоль и отдают команды, как мастер блока IT. Назначить можно любого участника."
        : "Сопровождающие видят консоль и отдают команды. Назначает их мастер блока IT."}</p>
      <QueryState loading={maintainers.isLoading} error={maintainers.error} keepDataOnError={!!maintainers.data} retry={() => { void maintainers.refetch(); }}>
        {!!maintainers.data?.items.length && <ul className={s.list}>
          {maintainers.data.items.map((person) => (
            <li key={person.user_id}>
              <div className={s.between}>
                <UserChip user={person} />
                {manages && <ActionForm fields={[]} variant="danger" submitLabel="Снять"
                  submitTitle={`Снять с сопровождения бота: ${person.display_name}`}
                  onSubmit={async () => { await change(person.user_id!, false); }} />}
              </div>
            </li>
          ))}
        </ul>}
        {maintainers.data && !maintainers.data.items.length && <Empty>Сопровождающих пока нет.</Empty>}
        {manages && <ActionForm title="Добавить сопровождающего" resetOnSuccess submitLabel="Назначить"
          fields={[{ name: "user", label: "Участник", type: "select", entity: "person", required: true, options: choices, loading: people.isLoading }]}
          onSubmit={async (values) => { await change(number(values, "user"), true); }} />}
        {manages && people.error && <QueryState loading={false} error={people.error}>{null}</QueryState>}
      </QueryState>
    </Card>
  );
}

/** /bot: the console of the IT block master and the maintainers (BOT_API.md, stage 5). */
export function BotConsolePage() {
  const { session } = useSession();
  if (!can(session, "view_bot_console"))
    return <Page title="Консоль бота"><Empty>Консоль бота видят мастер блока IT и сопровождающие, которых он назначил.</Empty></Page>;
  return <BotConsole operates={can(session, "operate_bot")} manages={can(session, "manage_bot_maintainers")} />;
}

function BotConsole({ operates, manages }: { operates: boolean; manages: boolean }) {
  const status = useQuery({
    queryKey: botConsoleKeys.status,
    queryFn: ({ signal }) => botConsoleApi.status(signal),
    refetchInterval: (current) => statusPollInterval(current.state.data, current.state.error),
    refetchIntervalInBackground: false,
  });
  const data = status.data;
  return (
    <Page title="Консоль бота" description="Бот ВКонтакте HereBot: его состояние, обновления, журнал и команды.">
      <div className={s.stack}>
        {data?.paused && <div role="status" className={s.warning}><p>{pauseText(data)}</p></div>}
        <QueryState loading={status.isLoading} error={status.error} keepDataOnError={!!data} retry={() => { void status.refetch(); }}>
          {data && <>
            {/* The age of the last report as of the last read: it moves on with each poll. */}
            <StatusCard status={data} now={status.dataUpdatedAt} />
            <UpdatesCard status={data} operates={operates} now={status.dataUpdatedAt} />
            {operates && <ControlCard status={data} now={status.dataUpdatedAt} />}
            {operates && <LogsCard status={data} />}
          </>}
        </QueryState>
        <CommandHistory />
        {data && <ErrorsCard errors={data.errors} />}
        <Maintainers manages={manages} />
      </div>
    </Page>
  );
}
