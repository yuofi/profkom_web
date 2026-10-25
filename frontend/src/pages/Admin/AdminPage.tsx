import { useState, type ReactNode } from "react";
import { Navigate, NavLink, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GuidesManagement } from "./panels/GuidesManagement";
import { Card, Empty, Page, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { PageNavContext } from "../../components/Workspace/sections";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { number } from "../../components/Workspace/formValues";
import { RegistrationsPage } from "../Workspace/MembershipPages";
import { LeadershipPage } from "../Workspace/SessionPages";
import { AccountArchivePage } from "../Workspace/DirectoryPages";
import { adminApi } from "../../utils/api/admin.api";
import { directoryApi } from "../../utils/api/directory.api";
import { materialsApi } from "../../utils/api/materials.api";
import { sessionApi } from "../../utils/api/session.api";
import type { TemporaryPassword } from "../../utils/api/contract";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { can, useSession } from "../../utils/session";
import s from "../../components/Workspace/Workspace.module.css";
import { visibleAdminTabs, type AdminTab } from "./adminTabs";

/** One cabinet; every tab shows only to those the server gives its right (АВ-34). */
const elements: Record<AdminTab, () => ReactNode> = {
  registrations: () => <RegistrationsPage />,
  leadership: () => <LeadershipPage />,
  accounts: () => <AccountArchivePage />,
  materials: () => <SharedMaterials />,
  pgas: () => <PgasAdmins />,
  passwords: () => <TemporaryPasswords />,
  guides: () => <Guides />,
};
/** Bookmarked addresses of the old admin panel. */
const moved: Record<string, string> = { users: "/admin/registrations", blocks: "/blocks", events: "/events" };

export const AdminPanel = () => {
  const { tab } = useParams<{ tab?: string }>();
  const { session } = useSession();
  const visible = visibleAdminTabs(session);
  if (tab && moved[tab]) return <Navigate to={moved[tab]} replace />;
  const current = visible.find((t) => t.tab === tab);
  if (!current) {
    // The cabinet opens on the registrations when they are visible.
    if (visible.length) return <Navigate to={`/admin/${visible[0].tab}`} replace />;
    return (
      <Page title="Администрирование">
        <Empty>Разделов администрирования для вас нет.</Empty>
      </Page>
    );
  }
  // The tabs stand under the page's header, as the section's own way between its pages.
  const tabs = (
    <nav className={s.tabs} aria-label="Администрирование">
      {visible.map((t) => (
        <NavLink key={t.tab} to={`/admin/${t.tab}`}>
          {t.label}
        </NavLink>
      ))}
      {can(session, "view_leadership") && (
        <>
          <NavLink to="/blocks">Блоки</NavLink>
          <NavLink to="/seasons">Сезоны и ККР</NavLink>
        </>
      )}
    </nav>
  );
  return (
    <PageNavContext.Provider value={tabs}>
      {elements[current.tab]()}
    </PageNavContext.Provider>
  );
};

function Guides() {
  return (
    <Page title="Управление гайдами" actions={<RouteLink to="/materials">Материалы</RouteLink>}>
      <GuidesManagement />
    </Page>
  );
}

function usePeople() {
  return useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts });
}
const fullName = (p: { surname: string; name: string }) => `${p.surname} ${p.name}`;

function SharedMaterials() {
  const materials = useQuery({ queryKey: ["materials"], queryFn: materialsApi.list });
  const people = usePeople();
  const name = (id: number) => {
    const person = people.data?.find((p) => p.user_id === id);
    return person ? fullName(person) : `#${id}`;
  };
  const shared = materials.data?.items.filter((m) => m.owner_block_id === null) ?? [];
  return (
    <Page title="Общие материалы и редакторы" description="Состав редакторов меняется на странице материала.">
      <QueryState loading={materials.isLoading} error={materials.error} keepDataOnError={!!materials.data}>
        <div className={s.stack}>
          {shared.map((m) => (
            <Card key={m.material_id} title={m.title}>
              <p>Редакторы: {m.editor_user_ids?.length ? m.editor_user_ids.map(name).join(", ") : "не назначены"}</p>
              <RouteLink to={`/materials/${m.material_id}`}>Открыть и изменить редакторов</RouteLink>
            </Card>
          ))}
          {materials.data && !shared.length && <Empty>Общих материалов нет.</Empty>}
        </div>
      </QueryState>
    </Page>
  );
}

function PgasAdmins() {
  const { perform } = useWorkspaceActions();
  const admins = useQuery({ queryKey: ["pgasAdmins"], queryFn: adminApi.pgasAdmins });
  const people = usePeople();
  const current = new Set(admins.data?.items.map((a) => a.user_id));
  const choices = people.data
    ?.filter((p) => !current.has(p.user_id))
    .map((p) => ({ value: String(p.user_id), label: fullName(p) })) ?? [];
  return (
    <Page
      title="Администраторы ПГАС"
      description="Председатель и замы правят ПГАС всегда. Право администратора ПГАС можно выдать любому участнику."
    >
      <QueryState loading={admins.isLoading || people.isLoading} error={admins.error || people.error} keepDataOnError={!!admins.data}>
        <div className={s.stack}>
          {admins.data?.items.map((a) => (
            <Card key={a.user_id} title={a.display_name}>
              <ActionForm
                fields={[]}
                submitLabel="Снять право"
                onSubmit={async () => {
                  await perform(() => adminApi.setPgasAdmin(a.user_id!, false));
                }}
              />
            </Card>
          ))}
          {admins.data?.items.length === 0 && <Empty>Администраторов ПГАС нет.</Empty>}
          <Card title="Выдать право">
            <ActionForm
              resetOnSuccess
              fields={[{ name: "user", label: "Участник", type: "select", required: true, options: choices }]}
              submitLabel="Выдать право"
              onSubmit={async (v) => {
                await perform(() => adminApi.setPgasAdmin(number(v, "user"), true));
              }}
            />
          </Card>
        </div>
      </QueryState>
    </Page>
  );
}

function TemporaryPasswords() {
  const people = usePeople();
  const leadership = useQuery({ queryKey: ["leadership"], queryFn: sessionApi.leadership });
  const [issued, setIssued] = useState<TemporaryPassword | null>(null);
  // The chair and deputies change their own passwords; the server refuses theirs.
  const leaders = new Set([leadership.data?.chair.user_id, ...(leadership.data?.deputies.map((d) => d.user_id) ?? [])]);
  const choices = people.data
    ?.filter((p) => !leaders.has(p.user_id))
    .map((p) => ({ value: String(p.user_id), label: fullName(p) })) ?? [];
  const person = issued && people.data?.find((p) => p.user_id === issued.user_id);
  return (
    <Page
      title="Сброс пароля"
      description="Писем сайт не отправляет. Временный пароль передайте лично; после входа участник обязан его сменить."
    >
      <QueryState loading={people.isLoading} error={people.error} keepDataOnError={!!people.data}>
        <div className={s.stack}>
          <Card title="Выдать временный пароль">
            <p>Прежний пароль перестанет действовать, а открытые сессии участника завершатся.</p>
            <ActionForm
              resetOnSuccess
              fields={[{ name: "user", label: "Участник", type: "select", required: true, options: choices }]}
              submitLabel="Выдать временный пароль"
              onSubmit={async (v) => {
                setIssued(null);
                setIssued(await adminApi.temporaryPassword(number(v, "user")));
              }}
            />
          </Card>
          {issued && (
            <Card title={person ? fullName(person) : "Временный пароль"}>
              <p>Почта для входа: {issued.email}</p>
              <p>
                Временный пароль: <code>{issued.temporary_password}</code>
              </p>
              <p className={s.muted}>Пароль показан один раз: сайт хранит только его хеш.</p>
              <button type="button" className={s.button} onClick={() => setIssued(null)}>
                Скрыть
              </button>
            </Card>
          )}
        </div>
      </QueryState>
    </Page>
  );
}

export default AdminPanel;
