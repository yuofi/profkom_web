import type { BlockOut, MeOut } from "./api/types";

export const isDemoMode =
  import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE !== "false";

export const demoUser: MeOut = {
  user_id: 7,
  email: "anna@example.com",
  surname: "Смирнова",
  name: "Анна",
  patronymic: "Сергеевна",
  kkr_name: "Анна Смирнова",
  group_number: "321",
  location: "ДСЛ",
  blocks: "Инфо,Культмас",
  phone: "+7 999 123-45-67",
  vk: "https://vk.com/id7",
  tg: "@anna",
  budget: true,
  in_profcom: true,
  photo_url: undefined,
  kkr_score: 128,
  banned: false,
  super_user: false,
  admin: false,
  pgas_admin: false,
  has_password: true,
  events_roles: JSON.stringify([
    { event: "Посвят", role: "главорг" },
    { event: "День Факультета", role: "организатор" },
  ]),
};

export const demoBlocks: BlockOut[] = [
  {
    name: "Инфо",
    master: demoUser.kkr_name,
    hr: "",
    cnt_of_human: 14,
    arr_of_human: [demoUser.user_id],
  },
  {
    name: "Культмас",
    master: "Иван Иванов",
    hr: demoUser.kkr_name,
    cnt_of_human: 22,
    arr_of_human: [demoUser.user_id],
  },
];
