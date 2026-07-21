import {z} from 'zod'

const isValidGroupEnding = (ending: number) => {
    const isStandardGroup = ending >= 1 && ending <= 20; // 01 - 20
    const isSpecialGroup = ending === 41 || ending === 42; // 41, 42
    
    return isStandardGroup || isSpecialGroup;
};

export const SignUpValidationSchema = z.object({
    email: z.email('Неправильный формат email'),
    password: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
    passwordAgain: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
    groupNumber: z.string().refine((value) => {
        const match = value.match(/(\d{2})$/);
        if (!match) return false; // Нет двух последних цифр
        
        const groupEnding = parseInt(match[1], 10);
        return isValidGroupEnding(groupEnding);
    }, {
        message: "Номер группы должен оканчиваться на 01-20, 41 или 42",
    }),
    telegram: z.string().min(1, "Telegram не может быть пустым"),
    name: z.string().min(1, "Имя не может быть пустым"),
    surname: z.string().min(1, "Фамилия не может быть пустым"),
    patronymic: z.string().min(1, "Отчество не может быть пустым"),

})
.refine((data) => data.password === data.passwordAgain, {
    message: "Пароли не совпадают",
    path: ["passwordAgain"]  
});

export const SignInValidationSchema = z.object({
    email: z.email('Неправильный формат email'),
    password: z.string().min(8, "длина пароля должна быть хотя бы 8 символов"),
});

export const ProfileValidationSchema = z.object({
  surname: z.string().min(1, "Фамилия не может быть пустым"),
  name: z.string().min(1, "Имя не может быть пустым"),
  patronymic: z.string().min(1, "Отчество не может быть пустым"),
  group_number: z.string().refine((value) => {
      if (!value) return true;
      const match = value.match(/(\d{2})$/);
      if (!match) return false; 
      
      const groupEnding = parseInt(match[1], 10);
      return isValidGroupEnding(groupEnding);
  }, {
      message: "Номер группы должен оканчиваться на 01-20, 41 или 42",
  }).optional().or(z.literal("")),
  budget: z.enum(["Бюджет", "Контракт"], "Выберите Бюджет или Контракт").optional(),
  location: z.string().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  tg: z.string().regex(
    /t\.me\/[a-zA-Z0-9_]{5,32}\/?$/,
    { message: "Ссылка должна вести на Telegram (t.me/имя_пользователя)" }
  ).optional().or(z.literal("")),
  email: z.string().email("Неправильный формат email").optional().or(z.literal("")),
  vk: z.string().regex(
    /^(https?:\/\/)?(www\.)?vk\.com\/[a-zA-Z0-9_]{5,32}\/?$/,
    { message: "Ссылка должна вести на ВКонтакте (vk.com/имя_пользователя)" }
  ).optional().or(z.literal("")),
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