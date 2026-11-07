import {z} from 'zod'
import { telegramField, vkField, patronymicField, isValidGroupNumber } from './contactFields';

export { isValidGroupNumber };

export const SignUpValidationSchema = z.object({
    email: z.email('Неправильный формат email'),
    password: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
    passwordAgain: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
    groupNumber: z.string().refine((value) => {
        return isValidGroupNumber(value);
    }, {
        message: "Номер группы должен быть числом от 100 до 700",
    }),
    telegram: telegramField.refine(Boolean, "Telegram не может быть пустым"),
    name: z.string().min(1, "Имя не может быть пустым"),
    surname: z.string().min(1, "Фамилия не может быть пустым"),
    patronymic: patronymicField,

})
.refine((data) => data.password === data.passwordAgain, {
    message: "Пароли не совпадают",
    path: ["passwordAgain"]  
});

// An address, or a login without @ and spaces: the service account's (backend/docs/SERVICE_ACCOUNT.md).
const signInLogin = z.string().refine(
    (value) => (value.includes('@') ? z.email().safeParse(value).success : /^\S+$/.test(value)),
    'Неправильный формат email',
);

export const SignInValidationSchema = z.object({
    email: signInLogin,
    password: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
});

export const ProfileValidationSchema = z.object({
  // The server refuses a blank surname or name too (PE-03).
  surname: z.string().trim().min(1, "Укажите фамилию"),
  name: z.string().trim().min(1, "Укажите имя"),
  patronymic: patronymicField,
  // A group cannot be cleared on the server: an empty field is an explicit error, not a no-op.
  group_number: z.string().trim().min(1, "Укажите номер группы").refine((value) => !value || isValidGroupNumber(value), {
      message: "Номер группы должен быть числом от 100 до 700",
  }),
  budget: z.enum(["Бюджет", "Контракт"], "Выберите Бюджет или Контракт").optional(),
  location: z.string().optional().or(z.literal("")),
  phone: z.string().trim().refine((value) => !value || /^\+?[0-9][0-9 ()-]{4,19}$/.test(value),
      "Укажите телефон цифрами, например +7 999 123-45-67").optional(),
  tg: telegramField.optional(),
  email: z.email("Неправильный формат email"),
  vk: vkField.optional(),
  photo_url: z.string().optional().or(z.literal(""))
});

export const ChangePasswordValidationSchema = z.object({
  oldPassword: z.string().optional(),
  newPassword: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
  newPasswordAgain: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
}).refine((data) => data.newPassword === data.newPasswordAgain, {
  message: "Пароли не совпадают",
  path: ["newPasswordAgain"]  
});
