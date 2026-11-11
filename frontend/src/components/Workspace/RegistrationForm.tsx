import type {
  RegistrationApplication,
} from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { text, type Values } from "./formValues";
import a from "./RegistrationForm.module.css";
import { can } from "../../utils/session";
import s from "./Workspace.module.css";
import { fundingLabels, registrationFieldsSchema, registrationLabels } from "../../utils/contactFields";
import { ApiError } from "../../utils/api/request";
const steps = [
  { title: "Личные данные", fields: ["surname", "name", "patronymic", "no_patronymic"] },
  { title: "Учёба", fields: ["group_number", "funding", "residence"] },
  { title: "Контакты", fields: ["phone", "email", "tg", "vk"] },
] as const;
const parsedFields = (v: Values) => registrationFieldsSchema.safeParse({
  ...Object.fromEntries(Object.keys(registrationLabels).map(k => [k, text(v, k)])),
  no_patronymic: text(v, "no_patronymic") === "true", funding: text(v, "funding"),
});
export function RegistrationForm({
  application,
}: {
  application: RegistrationApplication;
}) {
  const { perform, refresh } = useWorkspaceActions();
  const fields: Field[] = [
    ...Object.entries(registrationLabels).flatMap<Field>(([name, label]) => {
      const field: Field = {
        name, label, value: application.fields[name as keyof typeof registrationLabels] ?? "",
        required: true, type: name === "email" ? "email" : "text",
      };
      if (name !== "patronymic") return [field];
      const needsPatronymic = (values: Parameters<NonNullable<Field["visibleWhen"]>>[0]) => text(values, "no_patronymic") !== "true";
      return [
        { ...field, required: needsPatronymic, disabledWhen: values => !needsPatronymic(values), placeholder: "Введите отчество" },
        { name: "no_patronymic", label: "У меня нет отчества", type: "checkbox",
          value: String(application.fields.no_patronymic ?? false),
          hint: "Отметьте, только если отчества действительно нет.",
          onChangeValues: values => text(values, "no_patronymic") === "true" ? { ...values, patronymic: "" } : values },
      ];
    }),
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
      <div className={a.wizard}>
      <div className={a.main}>
      <ActionForm
        key={application.user_id}
        revision={application.revision}
        // Saving the details and resubmitting share one revision (A-FE-2).
        record={`registration:${application.user_id}`}
        fields={fields}
        requiredIndicator="none"
        steps={steps}
        stepHint={<p className={a.hint}><span aria-hidden="true">i</span><span><strong>Все поля обязательны.</strong> Если отчества нет, отметьте это отдельной галочкой.</span></p>}
        validateValues={values => {
          const result = parsedFields(values);
          return result.success ? {} : Object.fromEntries(result.error.issues.map(issue => [String(issue.path[0]), issue.message]));
        }}
        onSubmit={async (v, expectedRevision) => {
          const parsed = parsedFields(v);
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
      <p className={a.saveNote}>Можно вернуться назад и проверить введённые сведения. Сохраним анкету на последнем шаге.</p>
      </div>
      <aside className={a.side}>
        <span className={a.eyebrow}>Анкета участника</span>
        <h2>Давайте познакомимся ближе</h2>
        <p>Проверьте имя и фамилию, укажите отчество. Если его нет, отметьте это явно.</p>
        <p>Затем расскажите об учёбе и оставьте контакты, чтобы мы могли с вами связаться.</p>
        <div className={a.account}><span aria-hidden="true">{application.fields.name?.slice(0, 1)}{application.fields.surname?.slice(0, 1)}</span><div><strong>{application.fields.name} {application.fields.surname}</strong><small>Ваша анкета</small></div></div>
      </aside>
      </div>
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
