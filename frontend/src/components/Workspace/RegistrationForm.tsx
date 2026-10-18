import type {
  RegistrationApplication,
  RegistrationFields,
} from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { text } from "./formValues";
import { can } from "../../utils/session";
import s from "./Workspace.module.css";
const names = {
  surname: "Фамилия",
  name: "Имя",
  patronymic: "Отчество",
  group_number: "Группа",
  phone: "Телефон",
  email: "Почта",
  tg: "Telegram",
  vk: "VK",
  residence: "Место проживания",
};
export function RegistrationForm({
  application,
}: {
  application: RegistrationApplication;
}) {
  const { perform, refresh } = useWorkspaceActions();
  const fields: Field[] = [
    ...Object.entries(names).map(([name, label]) => ({
      name,
      label,
      value: application.fields[name as keyof typeof names] ?? "",
      required: name !== "patronymic",
      type: name === "email" ? ("email" as const) : ("text" as const),
    })),
    {
      name: "funding",
      label: "Основа обучения",
      type: "select",
      required: true,
      value: application.fields.funding,
      options: [
        { value: "budget", label: "Бюджет" },
        { value: "contract", label: "Контракт" },
      ],
    },
  ];
  return (
    <div className={s.stack}>
      <ActionForm
        key={application.user_id}
                  revision={application.revision}
        fields={fields}
        onSubmit={async (v, expectedRevision) => {
          const form = Object.fromEntries(
            Object.keys(names).map((k) => [k, text(v, k)]),
          );
          await perform(() =>
            membershipApi.updateRegistration({
              expected_revision: expectedRevision!,
              fields: {
                ...form,
                patronymic: text(v, "patronymic") || null,
                funding: text(v, "funding"),
              } as RegistrationFields,
            }),
          );
        }}
        submitLabel="Сохранить сведения"
        onConflict={refresh}
      />
      {application.status === "rejected" && (
        <>
          <p>
            Сначала сохраните исправления, затем отправьте заявку повторно.
            Аккаунт останется тем же.
          </p>
          {application.attempts_used < application.attempt_limit &&
          can(application, "resubmit_registration") ? (
            <ActionForm
              fields={[]}
              submitLabel="Повторно отправить заявку"
              onSubmit={async () => {
                await perform(() =>
                  membershipApi.resubmit({
                    expected_revision: application.revision,
                  }),
                );
              }}
              onConflict={() => {
                void refresh();
              }}
            />
          ) : (
            <p className={s.error}>
              Лимит пяти отправок исчерпан. Для повторной подачи нужен сброс
              счётчика руководством.
            </p>
          )}
        </>
      )}
    </div>
  );
}
