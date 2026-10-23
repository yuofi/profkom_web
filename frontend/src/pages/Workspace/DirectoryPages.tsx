import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
  Empty,
  Badge,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text, number } from "../../components/Workspace/formValues";
import { Avatar } from "../../components/Avatar/Avatar";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
import { normalizeApiError } from "../../utils/api/request";
import type { ArchivedAccount, FormerContact } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { displayDate } from "../../utils/dates";
import { ParticipantCategoryPanel } from "./MembershipPages";
import s from "../../components/Workspace/Workspace.module.css";
function Category({ userId }: { userId: number }) {
  const query = useQuery({
    queryKey: ["participantCategory", userId],
    queryFn: () => membershipApi.category(userId),
  });
  return query.data ? (
    <Badge>{query.data.category === "junior" ? "Джуниор" : "Активист"}</Badge>
  ) : (
    <span>
      {query.isError ? "Категория недоступна" : "Категория загружается…"}
    </span>
  );
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
    <div className={s.row}>
      {email && <a href={`mailto:${email}`}>{email}</a>}
      {phone && <a href={`tel:${phone.replace(/[^+\d]/g, "")}`}>{phone}</a>}
      {tg && (
        <a
          href={safe(tg, "https://t.me/")}
          target="_blank"
          rel="noopener noreferrer"
        >
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
  const [search, setSearch] = useState("");
  const [block, setBlock] = useState("");
  const [category, setCategory] = useState("");
  const [emails, setEmails] = useState("");
  const active = query.data?.filter((p) => p.in_profcom) ?? [];
  const categories = useQueries({
    queries: active.map((p) => ({
      queryKey: ["participantCategory", p.user_id],
      queryFn: () => membershipApi.category(p.user_id),
    })),
  });
  const categoryByUser = new Map(
    active.map((p, i) => [p.user_id, categories[i]]),
  );
  const categoriesPending = categories.some((q) => q.isPending);
  const categoryFailed = categories.some((q) => q.isError);
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
  const filtered = query.data?.filter(
    (p) =>
      p.in_profcom &&
      (!category ||
        categoryByUser.get(p.user_id)?.data?.category === category) &&
      (!block ||
        p.blocks
          .split(",")
          .map((x) => x.trim())
          .includes(block)) &&
      `${p.surname} ${p.name} ${p.patronymic} ${p.group_number} ${p.email}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Page
      title="Контакты"
      actions={<RouteLink to="/contacts/former">Бывшие участники</RouteLink>}
    >
      <div className={s.stack}>
        <div className={s.filters}>
          <label className={s.field}>
            Поиск по имени, группе, почте
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label className={s.field}>
            Блок
            <select value={block} onChange={(e) => setBlock(e.target.value)}>
              <option value="">Все блоки</option>
              {blocks.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
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
        </div>
        {category && categoriesPending && (
          <p role="status">Загружаем категории участников…</p>
        )}
        {categoryFailed && (
          <p role="alert">
            Часть категорий недоступна. Результат фильтра может быть неполным.{" "}
            <button
              className={s.button}
              onClick={() =>
                categories
                  .filter((q) => q.isError)
                  .forEach((q) => void q.refetch())
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
        {can(session, "restore_account") && (
          <RouteLink to="/admin/accounts">Архив аккаунтов</RouteLink>
        )}
        <QueryState
          loading={query.isLoading}
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        >
          <div className={s.stack}>
            {filtered?.map((p) => (
              <Card key={p.user_id}>
                <div className={s.between}>
                  <div className={s.row}>
                    <Avatar src={p.photo_url} size={56} />
                    <div>
                      <h2>
                        {p.surname} {p.name} {p.patronymic}
                      </h2>
                      <span className={s.muted}>
                        {p.group_number} · {p.blocks}
                      </span>
                    </div>
                  </div>
                  <Category userId={p.user_id} />
                </div>
                <ContactLinks {...p} />
                <details className={s.details}>
                  <summary>Подробнее</summary>
                  <p>
                    {p.location} · {p.budget ? "Бюджет" : "Контракт"}
                  </p>
                  {p.user_id === session?.user_id && (
                    <RouteLink to="/profile/edit">
                      Изменить свои контакты
                    </RouteLink>
                  )}
                  <ParticipantCategoryPanel userId={p.user_id} />
                  {can(session, "archive_account") && (
                    <ActionForm
                      fields={[
                        {
                          name: "reason",
                          label: "Причина архивирования аккаунта",
                          required: true,
                          type: "textarea",
                        },
                      ]}
                      submitLabel="Архивировать аккаунт"
                      onSubmit={async (v) => {
                        await perform(() =>
                          directoryApi.archive(p.user_id, text(v, "reason")),
                        );
                      }}
                    />
                  )}
                </details>
              </Card>
            ))}
          </div>
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
  const { perform } = useWorkspaceActions();
  return (
    <ActionForm
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
      onSubmit={async (v) => {
        const periods = text(v, "periods")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const match = line.trim().match(/^(\d{4})\s*[-–—]\s*(\d{4})$/);
            if (!match || Number(match[1]) > Number(match[2]))
              throw Error("Проверьте периоды участия");
            return { from_year: Number(match[1]), to_year: Number(match[2]) };
          });
        await perform(() =>
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
        <label className={s.field}>
          Поиск
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
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
  return (
    <ActionForm
      key={conflicts.map((c) => c.block_id).join("/")}
      fields={conflicts.map((c) => ({
        name: c.block_id,
        label: `Кто остаётся мастером блока ${c.block_id}`,
        type: "select" as const,
        required: true,
        options: [
          {
            value: String(c.current_master.user_id),
            label: c.current_master.display_name,
          },
          { value: String(account.user_id), label: account.display_name },
        ],
      }))}
      submitLabel="Восстановить аккаунт"
      onSubmit={async (v) => {
        try {
          await perform(() =>
            directoryApi.restore(
              account.user_id,
              conflicts.map((c) => ({
                block_id: c.block_id,
                keep_user_id: number(v, c.block_id),
              })),
            ),
          );
        } catch (e) {
          const error = normalizeApiError(e);
          if (
            error.code === "master_conflict" &&
            Array.isArray(error.fields.master_conflicts)
          )
            setConflicts(error.fields.master_conflicts);
          throw e;
        }
      }}
    />
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
