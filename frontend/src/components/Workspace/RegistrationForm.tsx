import type {
  RegistrationApplication,
} from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { text } from "./formValues";
import { can } from "../../utils/session";
import s from "./Workspace.module.css";
import { fundingLabels, registrationFieldsSchema, registrationLabels } from "../../utils/contactFields";
import { ApiError } from "../../utils/api/request";
export function RegistrationForm({
  application,
}: {
  application: RegistrationApplication;
}) {
  const { perform, refresh } = useWorkspaceActions();
  const fields: Field[] = [
    ...Object.entries(registrationLabels).map(([name, label]) => ({
      name,
      label,
      value: application.fields[name as keyof typeof registrationLabels] ?? "",
      required: name !== "patronymic",
      type: name === "email" ? ("email" as const) : ("text" as const),
    })),
    {
      name: "funding",
      label: "Основа обучения",
      type: "select",
      required: true,
      // A VK application starts unchosen: no basis is preselected (decision 28).
      value: application.fields.funding ?? "",
      options: Object.entries(fundingLabels).map(([value, label]) => ({ value, label })),
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
            Object.keys(registrationLabels).map((k) => [k, text(v, k)]),
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
          {can(application, "resubmit_registration") ? (
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
