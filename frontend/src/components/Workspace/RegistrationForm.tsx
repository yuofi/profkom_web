import type {
  RegistrationApplication,
} from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { text } from "./formValues";
import { can } from "../../utils/session";
import s from "./Workspace.module.css";
import { registrationFieldsSchema } from "../../utils/contactFields";
import { ApiError } from "../../utils/api/request";
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
        // Saving the details and resubmitting share one revision (A-FE-2).
        record={`registration:${application.user_id}`}
        fields={fields}
        onSubmit={async (v, expectedRevision) => {
          const form = Object.fromEntries(
            Object.keys(names).map((k) => [k, text(v, k)]),
          );
          const parsed = registrationFieldsSchema.safeParse({ ...form, funding: text(v, "funding") });
          if (!parsed.success) throw new ApiError("Проверьте сведения и контакты", 422, "validation_error", {
            errors: parsed.error.issues.map(issue => ({ loc: issue.path, msg: issue.message })),
          });
          return perform(() =>
            membershipApi.updateRegistration({
              expected_revision: expectedRevision!,
              fields: parsed.data,
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
              revision={application.revision}
              record={`registration:${application.user_id}`}
              onSubmit={async (_v, expectedRevision) => {
                return perform(() =>
                  membershipApi.resubmit({
                    expected_revision: expectedRevision!,
                  }),
                );
              }}
              onConflict={refresh}
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
