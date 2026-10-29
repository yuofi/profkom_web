import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
  Empty,
  Badge,
  Glyph,
} from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { ContactDialog } from "../../components/Workspace/ContactDialog";
import d from "./DirectoryCards.module.css";
import { ActionForm, type Field } from "../../components/Workspace/ActionForm";
import { text, number } from "../../components/Workspace/formValues";
import { Avatar } from "../../components/Avatar/Avatar";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
import { normalizeApiError, canRetainData } from "../../utils/api/request";
import type { ArchivedAccount, FormerContact, ParticipantCategory } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { displayDate } from "../../utils/dates";
import { getBlockRoute } from "../../utils/routes";
import { ParticipantCategoryPanel } from "./ParticipantCategoryPanel";
import s from "../../components/Workspace/Workspace.module.css";
function Category({ category, pending }: { category?: ParticipantCategory; pending: boolean }) {
  return category ? (
    <Badge tone={category.category === "junior" ? "mint" : undefined}>{category.category === "junior" ? "Джуниор" : "Активист"}</Badge>
  ) : <span>{pending ? "Категория загружается…" : "Категория недоступна"}</span>;
}
function ContactLinks({
  email,
  phone,
  tg,
  vk,
}: {
  email: string;
  phone: string;
  tg: string;
  vk: string;
}) {
  const safe = (link: string, prefix: string) =>
    /^https?:\/\//i.test(link) ? link : `${prefix}${link.replace(/^@/, "")}`;
  return (
    <div className={s.contactLinks}>
      {email && <a href={`mailto:${email}`}><Glyph name="mail" />{email}</a>}
      {phone && <a href={`tel:${phone.replace(/[^+\d]/g, "")}`}><Glyph name="call" />{phone}</a>}
      {tg && (
        <a
          href={safe(tg, "https://t.me/")}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Glyph name="send" />
          Telegram
        </a>
      )}
      {vk && (
        <a
          href={safe(vk, "https://vk.com/")}
          target="_blank"
          rel="noopener noreferrer"
        >
          VK
        </a>
      )}
    </div>
  );
}
export function DirectoryPage() {
  const { session } = useSession();
  const { perform } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["contacts"],
    queryFn: directoryApi.contacts,
  });
  const blockDirectory = useQuery({ queryKey: ["workspaceBlocks"], queryFn: membershipApi.blocks });
  const blockCards = (!blockDirectory.error || canRetainData(blockDirectory.error) ? blockDirectory.data : undefined) ?? [];
  const [search, setSearch] = useState("");
  const [block, setBlock] = useState("");
  const [category, setCategory] = useState("");
  const [funding, setFunding] = useState("");
  const [course, setCourse] = useState("");
  const [emails, setEmails] = useState("");
  const [selected, setSelected] = useState<{ id: number; mode: "details" | "manage" } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() =>
    typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 769px)").matches,
  );
  const active = query.data?.filter((p) => p.in_profcom) ?? [];
  const participantIds = [...new Set(active.map((p) => p.user_id))].sort((a, b) => a - b);
  const categories = useQuery({
    queryKey: ["participantCategory", "batch", participantIds],
    queryFn: () => membershipApi.categories(participantIds),
    enabled: participantIds.length > 0,
  });
  const categoryData = categories.error && !canRetainData(categories.error) ? undefined : categories.data;
  const categoryByUser = new Map(categoryData?.map((item) => [item.user_id, item] as const) ?? []);
  const categoriesPending = participantIds.length > 0 && categories.isPending;
  const categoryFailed = categories.isError || (!!categoryData && participantIds.some((id) => !categoryByUser.has(id)));
  const blocks = Array.from(
    new Set(
      query.data?.flatMap((p) =>
        p.blocks
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ) ?? [],
    ),
  );
  // The course is the first digit of the group (owner, 2026-10-25): 301 is the third.
  const courseOf = (p: { group_number?: string | number | null }) =>
    /^\d/.test(String(p.group_number ?? "").trim()) ? String(p.group_number).trim()[0] : "";
  const courses = Array.from(new Set(active.map(courseOf).filter(Boolean))).sort();
  const filtered = query.data?.filter(
    (p) =>
      p.in_profcom &&
      (!funding || (funding === "budget") === !!p.budget) &&
      (!course || courseOf(p) === course) &&
      (!category ||
        categoryByUser.get(p.user_id)?.category === category) &&
      (!block ||
        p.blocks
          .split(",")
          .map((x) => x.trim())
          .includes(block)) &&
      `${p.surname} ${p.name} ${p.patronymic} ${p.group_number} ${p.email}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const selectedPerson = query.data?.find((p) => p.user_id === selected?.id);
  const mayManage = can(session, "edit_participant_category") || can(session, "archive_account");
  return (
    <Page
      title="Контактная информация"
      actions={
        <div className={s.row}>
          {can(session, "restore_account") && (
            <RouteLink to="/admin/accounts">Архив аккаунтов</RouteLink>
          )}
          <RouteLink to="/contacts/former">Бывшие участники</RouteLink>
        </div>
      }
    >
      <div className={s.stack}>
        <div className={s.filters}>
          <label className={`${s.field} ${s.search}`}>
            Поиск
            <input
              type="search"
              placeholder="Имя, группа или почта"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <details
          className={`${s.details} ${s.filterDetails}`}
          open={filtersOpen}
          onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
        >
          <summary>
            Фильтры{[block, category, funding, course].filter(Boolean).length > 0 && ` · ${[block, category, funding, course].filter(Boolean).length}`}
          </summary>
          <div className={s.filters}>
            <EntityPicker label="Блок" value={block} onChange={setBlock} placeholder="Все блоки" options={[{ value: "", label: "Все блоки" }, ...blocks.map(name => ({ value: name, label: name, block: { name } }))]} />
            <label className={s.field}>
              Категория
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Все категории</option>
                <option value="junior">Джуниоры</option>
                <option value="activist">Активисты</option>
              </select>
            </label>
            <label className={s.field}>
              Форма обучения
              <select value={funding} onChange={(e) => setFunding(e.target.value)}>
                <option value="">Все формы</option>
                <option value="budget">Бюджет</option>
                <option value="contract">Контракт</option>
              </select>
            </label>
            <label className={s.field}>
              Курс
              <select value={course} onChange={(e) => setCourse(e.target.value)}>
                <option value="">Все курсы</option>
                {courses.map((c) => (
                  <option key={c} value={c}>{c} курс</option>
                ))}
              </select>
            </label>
          </div>
        </details>
        {category && categoriesPending && (
          <p role="status">Загружаем категории участников…</p>
        )}
        {categoryFailed && (
          <p role="alert">
            Часть категорий недоступна. Результат фильтра может быть неполным.{" "}
            <button
              className={s.button}
              onClick={() =>
                void categories.refetch()
              }
            >
              Повторить загрузку категорий
            </button>
          </p>
        )}
        <details className={s.details}>
          <summary>Почтовая выгрузка</summary>
          <ActionForm
            fields={[]}
            submitLabel="Получить список адресов"
            onSubmit={async () => {
              setEmails((await directoryApi.emails()).emails.join("; "));
            }}
          />
          {emails && (
            <label className={s.field}>
              Адреса для копирования
              <textarea
                readOnly
                value={emails}
                rows={3}
                onFocus={(e) => e.target.select()}
              />
            </label>
          )}
        </details>
        <QueryState
          loading={query.isLoading}
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        >
          {filtered && filtered.length > 0 && (
            <p className={s.results} role="status">
              Показано контактов: {filtered.length} из {active.length}
            </p>
          )}
          <div className={`${s.contactGrid} ${d.grid}`}>
            {filtered?.map((p) => (
              <Card key={p.user_id} className={d.card}>
                <div className={d.header}>
                  <Avatar src={p.photo_url} size={48} loading="lazy" />
                  <div className={d.identity}>
                    <h2>{p.surname} {p.name} {p.patronymic}</h2>
                    <p className={d.summary}>{p.group_number || "Группа не указана"}</p>
                    <div className={d.blocks}>{[...new Set([...p.blocks.split(",").map(name => name.trim()).filter(Boolean), ...blockCards.filter(block => block.master?.user.user_id === p.user_id).map(block => block.name)])].map((name, index) => {
                      const item = blockCards.find(block => block.name === name);
                      const master = item?.master?.user.user_id === p.user_id;
                      return <span key={item?.block_id ?? name}>{index > 0 && ", "}<span className={master ? d.masterBlock : undefined} data-block-master={master || undefined}>
                        {item ? <Link className={d.blockLink} to={getBlockRoute(item.block_id)} title={name} aria-description={master ? "Руководит блоком" : undefined}>{master && <svg className={d.masterIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 6 5 4 4-6 4 6 5-4-2 12H5L3 6Z" /><path d="M5 21h14" /></svg>}{name}</Link> : <span className={s.muted}>{name}</span>}
                      </span></span>;
                    })}</div>
                  </div>
                  <div className={d.category}><Category category={categoryByUser.get(p.user_id)} pending={categoriesPending} /></div>
                </div>
                <div className={d.actions}>
                  <button className={s.button} type="button" onClick={() => setSelected({ id: p.user_id, mode: "details" })}>Подробнее</button>
                  {mayManage && <button className={s.button} type="button" onClick={() => setSelected({ id: p.user_id, mode: "manage" })}>Управление аккаунтом</button>}
                </div>
              </Card>
            ))}
          </div>
          {selectedPerson && selected && (
            <UnsavedChangesScope><ContactDialog key={`${selected.id}-${selected.mode}`} title={selected.mode === "manage" ? "Управление аккаунтом" : `${selectedPerson.surname} ${selectedPerson.name} ${selectedPerson.patronymic}`.trim()} onClose={() => setSelected(null)}>
              {selected.mode === "details" ? <>
                <p>{[selectedPerson.group_number, selectedPerson.blocks].filter(Boolean).join(" · ")}</p>
                <p>{[selectedPerson.location, selectedPerson.budget ? "Бюджет" : "Контракт"].filter(Boolean).join(" · ")}</p>
                <ContactLinks {...selectedPerson} />
                {selectedPerson.user_id === session?.user_id && <RouteLink to="/profile/edit">Изменить свои контакты</RouteLink>}
              </> : mayManage ? <>
                <p>{selectedPerson.surname} {selectedPerson.name} {selectedPerson.patronymic}</p>
                <ParticipantCategoryPanel userId={selectedPerson.user_id} />
                {can(session, "archive_account") && <ActionForm
                  fields={[{ name: "reason", label: "Причина архивирования аккаунта", required: true, type: "textarea" }]}
                  submitLabel="Архивировать аккаунт" variant="danger"
                  onSubmit={async (v) => {
                    await perform(() => directoryApi.archive(selectedPerson.user_id, text(v, "reason")));
                    setSelected(null);
                  }}
                />}
              </> : <p>Управление аккаунтом недоступно.</p>}
            </ContactDialog></UnsavedChangesScope>
          )}
          {filtered?.length === 0 &&
            !(category && (categoriesPending || categoryFailed)) && (
              <Empty>Подходящих контактов нет.</Empty>
            )}
        </QueryState>
      </div>
    </Page>
  );
}
function FormerForm({ contact }: { contact?: FormerContact }) {
  const { perform, refresh } = useWorkspaceActions();
  return (
    <ActionForm
      revision={contact?.revision}
      record={contact ? `former:${contact.contact_id}` : undefined}
      onConflict={refresh}
      fields={[
        ...Object.entries({
          surname: "Фамилия",
          name: "Имя",
          patronymic: "Отчество",
          phone: "Телефон",
          email: "Почта",
          tg: "Telegram",
          vk: "VK",
        }).map(([name, label]) => ({
          name,
          label,
          required: ["surname", "name"].includes(name),
          value: (contact?.[name as keyof FormerContact] as string) ?? "",
        })),
        {
          name: "periods",
          label: "Периоды участия: каждый с новой строки, например 2020–2022",
          type: "textarea",
          required: true,
          value:
            contact?.participation_periods
              .map((p) => `${p.from_year}–${p.to_year}`)
              .join("\n") ?? "",
        },
      ]}
      onSubmit={async (v, expectedRevision) => {
        const periods = text(v, "periods")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const match = line.trim().match(/^(\d{4})\s*[-–—]\s*(\d{4})$/);
            if (!match || Number(match[1]) > Number(match[2]))
              throw Error("Проверьте периоды участия");
            return { from_year: Number(match[1]), to_year: Number(match[2]) };
          });
        return perform(() =>
          directoryApi.saveFormer(
            {
              surname: text(v, "surname"),
              name: text(v, "name"),
              patronymic: text(v, "patronymic"),
              phone: text(v, "phone"),
              email: text(v, "email"),
              tg: text(v, "tg"),
              vk: text(v, "vk"),
              participation_periods: periods,
              ...(contact ? { expected_revision: expectedRevision! } : {}),
            },
            contact?.contact_id,
          ),
        );
      }}
    />
  );
}
export function FormerContactsPage() {
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["formerContacts"],
    queryFn: directoryApi.former,
  });
  const [search, setSearch] = useState("");
  return (
    <Page
      title="Бывшие участники"
      description="Контактные карточки с периодами участия."
      actions={<RouteLink to="/contacts">Действующие контакты</RouteLink>}
    >
      <div className={s.stack}>
        <div className={s.filters}>
          <label className={`${s.field} ${s.search}`}>
            Поиск
            <input
              type="search"
              placeholder="Фамилия или имя"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <QueryState loading={query.isLoading} error={query.error}>
          {query.data?.items
            .filter((p) =>
              `${p.surname} ${p.name}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((p) => (
              <Card
                key={p.contact_id}
                title={`${p.surname} ${p.name} ${p.patronymic ?? ""}`}
              >
                <p>
                  {p.participation_periods
                    .map((period) => `${period.from_year}–${period.to_year}`)
                    .join(", ")}
                </p>
                <ContactLinks {...p} />
                {can(session, "edit_former_contacts") && (
                  <details className={s.details}>
                    <summary>Редактировать карточку</summary>
                    <FormerForm contact={p} />
                  </details>
                )}
              </Card>
            ))}
        </QueryState>
        {can(session, "edit_former_contacts") && (
          <Card title="Добавить бывшего участника">
            <FormerForm />
          </Card>
        )}
      </div>
    </Page>
  );
}
function RestoreForm({ account }: { account: ArchivedAccount }) {
  const { perform } = useWorkspaceActions();
  const [conflicts, setConflicts] = useState(account.master_conflicts ?? []);
  const [assignments, setAssignments] = useState<{ role_assignment_id: string; legacy_scope_id: string | null }[]>([]);
  const blocks = useQuery({ queryKey: ["workspaceBlocks"], queryFn: membershipApi.blocks, enabled: assignments.length > 0 || conflicts.some(conflict => !conflict.block_name) });
  const blockOptions = (!blocks.error || canRetainData(blocks.error) ? blocks.data : undefined)?.map(block => ({ value: block.block_id, label: block.name, block })) ?? [];
  return (
    <>
    {assignments.length > 0 && <div role="status"><p>У прежних назначений нет подтверждённой связи с действующим блоком. Для каждого назначения выберите блок вручную; совпадение названий не определяет соответствие.</p><QueryState loading={blocks.isLoading} error={blocks.error} retry={() => void blocks.refetch()}>{null}</QueryState></div>}
    <ActionForm
      fields={[...assignments.map((assignment, index): Field => ({
        name: `mapping-${assignment.role_assignment_id}`,
        label: `Действующий блок для назначения ${index + 1}: ${assignment.legacy_scope_id || "прежний блок не указан"}`,
        type: "select",
        entity: "block",
        required: true,
        loading: blocks.isLoading,
        options: blockOptions,
      })), ...conflicts.map((c): Field => ({
        name: `master-${c.block_id}`,
        label: `Кто остаётся мастером блока ${c.block_name ?? blockOptions.find(block => block.value === c.block_id)?.label ?? "(блок недоступен)"}`,
        type: "select" as const,
        required: true,
        options: [
          {
            value: String(c.current_master.user_id),
            label: c.current_master.display_name,
            user: c.current_master,
          },
          { value: String(account.user_id), label: account.display_name, user: { user_id: account.user_id, display_name: account.display_name, avatar_url: null } },
        ],
      }))]}
      submitLabel="Восстановить аккаунт"
      allowExitSave={false}
      onSubmit={async (v) => {
        try {
          await perform(() =>
            directoryApi.restore(
              account.user_id,
              conflicts.map((c) => ({
                block_id: c.block_id,
                keep_user_id: number(v, `master-${c.block_id}`),
              })),
              assignments.map(assignment => ({ role_assignment_id: assignment.role_assignment_id, block_id: text(v, `mapping-${assignment.role_assignment_id}`) })),
            ),
          );
        } catch (e) {
          const error = normalizeApiError(e);
          if (error.code === "archive_scope_mapping_required" && Array.isArray(error.fields.assignments)) {
            const required = error.fields.assignments.filter((entry): entry is { role_assignment_id: string; legacy_scope_id: string | null } => !!entry && typeof entry === "object" && typeof entry.role_assignment_id === "string" && (typeof entry.legacy_scope_id === "string" || entry.legacy_scope_id === null));
            setAssignments(current => [...new Map([...current, ...required].map(entry => [entry.role_assignment_id, entry])).values()]);
          }
          if (
            error.code === "master_conflicts" &&
            Array.isArray(error.fields.master_conflicts)
          )
            setConflicts(error.fields.master_conflicts);
          throw e;
        }
      }}
    />
    </>
  );
}
export function AccountArchivePage() {
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["archivedAccounts"],
    queryFn: directoryApi.archived,
    enabled: can(session, "restore_account"),
  });
  if (!can(session, "restore_account"))
    return (
      <Page title="Архив аккаунтов">
        <Empty>Архив аккаунтов доступен председателю.</Empty>
      </Page>
    );
  return (
    <Page
      title="Архив аккаунтов"
      description="Архивирование отключает вход и назначения. При восстановлении нужно разрешить конфликты мастеров."
    >
      <QueryState loading={query.isLoading} error={query.error}>
        <div className={s.stack}>
          {!can(session, "restore_account") && (
            <Empty>Архив аккаунтов доступен председателю.</Empty>
          )}
          {query.data?.items.map((a) => (
            <Card key={a.user_id} title={a.display_name}>
              <p>В архиве с {displayDate(a.archived_at)}</p>
              <RestoreForm account={a} />
            </Card>
          ))}
          {query.data?.items.length === 0 && <Empty>Архив пуст.</Empty>}
        </div>
      </QueryState>
    </Page>
  );
}
