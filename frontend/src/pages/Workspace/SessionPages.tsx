import { useState } from "react";
import { canRetainData } from "../../utils/api/request";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useLogout } from "../../utils/hooks/useLogout";
import {
  Page,
  Card,
  Loading,
  ErrorState,
  QueryState,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { number, ids } from "../../components/Workspace/formValues";
import { useSession, can } from "../../utils/session";
import { authApi } from "../../utils/api/auth.api";
import { text } from "../../components/Workspace/formValues";
import { membershipApi } from "../../utils/api/membership.api";
import { sessionApi } from "../../utils/api/session.api";
import { directoryApi } from "../../utils/api/directory.api";
import { clearPrivateCache } from "../../utils/api/invalidation";
import s from "../../components/Workspace/Workspace.module.css";
import { RegistrationForm } from "../../components/Workspace/RegistrationForm";
import { missingFields } from "../../utils/contactFields";
import { DemoRolePicker } from "../../components/Workspace/DemoRolePicker";
export function AccountStatePage() {
  const { session } = useSession();
  const { logout, busy, error } = useLogout();
  const application = useQuery({
    queryKey: ["registrations", "me"],
    queryFn: membershipApi.registration,
    enabled: session?.account_state === "pending",
    retry: false,
  });
  const missing = application.data ? missingFields(application.data.fields) : [];
  const reason = application.data?.rejection_reason;
  return (
    <Page
      title={
        session?.account_state === "archived"
          ? "Аккаунт в архиве"
          : session?.registration_status === "rejected"
            ? "Нужно уточнить сведения"
            : "Заявка на рассмотрении"
      }
      description="Рабочие разделы станут доступны после одобрения регистрации."
    >
      <Card>
        <DemoRolePicker />
        <QueryState loading={application.isLoading} error={application.error} keepDataOnError={!!application.data}>
          <>
            {reason && <p>{reason}</p>}
            {missing.length > 0 ? (
              <p role="status">
                Заполните обязательные поля: {missing.join(", ")}.
                {application.data?.status === "pending" && " Заявка уйдёт на рассмотрение, когда все сведения будут сохранены."}
              </p>
            ) : (
              !reason && <p>Дождитесь решения руководства Профкома.</p>
            )}
            {application.data && (
              <p>
                Использовано отправок: {application.data.attempts_used} из{" "}
                {application.data.attempt_limit}.
              </p>
            )}
            {application.data && application.data.status !== "approved" && (
              <RegistrationForm application={application.data} />
            )}
          </>
        </QueryState>
        <button className={s.button} disabled={busy} onClick={() => void logout()}>
          {busy ? "Выходим…" : "Ко входу"}
        </button>
        {error && <p role="alert" className={s.error}>{error}</p>}
      </Card>
    </Page>
  );
}
/** A temporary password from the chair or a deputy: the server opens nothing else until
 *  it is changed (АВ-52). The change ends every session, this one too. */
export function PasswordChangePage() {
  const { logout, busy, error } = useLogout();
  const [changed, setChanged] = useState(false);
  return (
    <Page
      title="Смените временный пароль"
      description="Пароль выдали председатель или зам. Пока он не сменён, рабочие разделы закрыты."
    >
      <Card>
        {changed ? (
          <p role="status">Пароль изменён. Войдите с новым паролем.</p>
        ) : (
          <ActionForm
            fields={[
              { name: "old", label: "Временный пароль", type: "password", required: true },
              { name: "password", label: "Новый пароль", type: "password", required: true },
              { name: "again", label: "Новый пароль ещё раз", type: "password", required: true },
            ]}
            submitLabel="Сменить пароль"
            onSubmit={async (v) => {
              const password = text(v, "password");
              if (password.length < 8) throw Error("Длина пароля должна быть хотя бы 8 символов");
              if (password !== text(v, "again")) throw Error("Пароли не совпадают");
              if (password === text(v, "old")) throw Error("Новый пароль должен отличаться от временного");
              await authApi.changePassword({ old_password: text(v, "old"), new_password: password });
              setChanged(true);
            }}
          />
        )}
        <button className={s.button} disabled={busy} onClick={() => void logout()}>
          {busy ? "Выходим…" : "Ко входу"}
        </button>
        {error && <p role="alert" className={s.error}>{error}</p>}
      </Card>
    </Page>
  );
}
export function WorkspaceStartPage() {
  return (
    <Page
      title="Рабочий экран"
      description="Задачи, команды и ближайшие встречи в одном месте."
    >
      <div className={s.grid}>
        <Card title="Мои задачи">
          <Link className={s.linkButton} to="/tasks">
            Открыть задачи
          </Link>
        </Card>
        <Card title="Мероприятия">
          <Link className={s.linkButton} to="/events">
            Мои команды
          </Link>
        </Card>
        <Card title="Блоки">
          <Link className={s.linkButton} to="/blocks">
            Открыть блоки
          </Link>
        </Card>
      </div>
    </Page>
  );
}
export function ComingPage({ title }: { title: string }) {
  return (
    <Page title={title}>
      <Card>
        <p>Здесь пока нет доступных записей.</p>
      </Card>
    </Page>
  );
}
export function LeadershipPage() {
  const { session } = useSession();
  const client = useQueryClient();
  const leadership = useQuery({
    queryKey: ["leadership"],
    queryFn: sessionApi.leadership,
  });
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: directoryApi.contacts,
  });
  if (leadership.isLoading) return <Loading />;
  if (leadership.error && (!leadership.data || !canRetainData(leadership.error))) return <ErrorState error={leadership.error} />;
  if (contacts.isLoading) return <Loading />;
  if (contacts.error && (!contacts.data || !canRetainData(contacts.error))) return <ErrorState error={contacts.error} retry={() => { void contacts.refetch(); }} />;
  const current = leadership.data!;
  const choices =
    contacts.data
      ?.filter((p) => p.in_profcom && p.user_id !== current.chair.user_id)
      .map((p) => ({
        value: String(p.user_id),
        label: `${p.surname} ${p.name}`,
      })) ?? [];
  const requireEligible = (userIds: number[]) => {
    if (userIds.some((id) => !choices.some((p) => Number(p.value) === id)))
      throw Error("Выбранный участник больше не доступен для назначения. Проверьте выбор.");
  };
  return (
    <Page title="Руководство Профкома">
      {(leadership.error || contacts.error) && <ErrorState error={leadership.error || contacts.error} />}
      <div className={s.stack}>
        <Card title="Текущий состав">
          <p>Председатель: {current.chair.display_name}</p>
          <p>
            Заместители:{" "}
            {current.deputies.map((p) => p.display_name).join(", ") ||
              "не назначены"}
          </p>
        </Card>
        {can(current, "transfer_chair") && can(session, "transfer_chair") && (
          <Card title="Передача поста">
            <p>
              Новый председатель получит полномочия. Прежние заместители
              потеряют глобальные права; остальные назначения сохранятся.
            </p>
            <ActionForm
              key="transfer"
              revision={current.revision}
              fields={[
                {
                  name: "user",
                  label: "Новый председатель",
                  type: "select",
                  options: choices,
                  required: true,
                },
              ]}
              submitLabel="Передать пост"
              onSubmit={async (v, expectedRevision) => {
                const userId = number(v, "user");
                requireEligible([userId]);
                const saved = await sessionApi.transfer(userId, {
                  expected_revision: expectedRevision!,
                });
                await clearPrivateCache(client);
                return saved;
              }}
              onConflict={() => leadership.refetch({ throwOnError: true })}
            />
          </Card>
        )}
        {can(current, "manage_chair_deputies") && (
          <Card title="Заместители председателя">
            <ActionForm
              key="deputies"
              revision={current.revision}
              fields={[
                {
                  name: "users",
                  label: "До трёх заместителей",
                  type: "multi",
                  value: current.deputies.map((p) => String(p.user_id)),
                  options: choices,
                },
              ]}
              onSubmit={async (v, expectedRevision) => {
                const selected = ids(v, "users");
                requireEligible(selected);
                if (selected.length > 3)
                  throw Error("Можно назначить не более трёх заместителей");
                const saved = await sessionApi.deputies(selected, {
                  expected_revision: expectedRevision!,
                });
                await client.invalidateQueries({ queryKey: ["leadership"] });
                await clearPrivateCache(client);
                return saved;
              }}
              onConflict={() => leadership.refetch({ throwOnError: true })}
            />
          </Card>
        )}
      </div>
    </Page>
  );
}
