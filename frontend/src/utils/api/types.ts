export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type?: string;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RefreshResponse {
    access_token: string;
    refresh_token: string;
}

// То, что отправляется при регистрации пользователя
export interface UserIn {
  name: string;
  surname: string;
  patronymic: string;
  password: string;
  kkr_score?: number;
  group_number: number;
  tg: string;
  blocks?: string;
  banned?: boolean; 
  super_user?: boolean;
  admin?: boolean;
  email: string;
}

export interface LoginIn {
  email: string;
  password: string;
}

// То, что приходит с бэкенда при запросе профиля
export interface UserOut {
  user_id: number;
  email: string;
  name: string;
  surname: string;
  patronymic: string;
  kkr_score: number;
  group_number: number;
  blocks: string;
  banned: boolean;
  super_user: boolean;
  admin: boolean;
  photo_url?: string;
}

// Данные контакта (используется при регистрации)
export interface ContactInfoIn {
  surname: string;
  name: string;
  patronymic: string;
  kkr_name: string;
  group_number: string;
  location: string;
  blocks: string;
  phone: string;
  vk: string;
  tg: string;
  email: string;
  budget: boolean;
  in_profcom: boolean;
  photo_url?: string;
}


export interface ContactInfoOut extends ContactInfoIn {
  kkr_score: number;
  user_id: number;
}

export interface MeOut extends ContactInfoOut  {
    banned: boolean;
    super_user: boolean;
    admin: boolean;
    has_password?: boolean;
}


export interface ProfileUpdate {
  surname?: string;
  name?: string;
  patronymic?: string;
  kkr_name?: string;
  group_number?: string;
  location?: string;
  blocks?: string;
  phone?: string;
  vk?: string;
  tg?: string;
  email?: string;
  budget?: boolean;
  in_profcom?: boolean;
  photo_url?: string;
}

export interface ContactFilter {
  group_number?: number;
  blocks?: string;
  in_profcom?: boolean;
  budget?: boolean;
}

export interface GuideIn {
  title: string;
  owner_block?: string;
  text?: string;
  description?: string;
  original_link?: string | null; 
}

export interface GuideUpdate {
  title?: string;
  owner_block?: string;
  text?: string;
  description?: string;
  original_link?: string | null;
}

export interface GuideOut {
  guide_id: number;
  title: string;
  owner_block: string;
  text: string;
  description?: string;
  original_link?: string | null;
}

export interface BlockOut {
  name: string;
  master: string;
  hr: string;
  cnt_of_human: number;
  arr_of_human: number[];
}

export interface BlockIn {
  name: string;
  master: string;
  hr?: string;
  cnt_of_human?: number;
  arr_of_human?: number[];
}

export interface BlockUpdate {
  master?: string;
  hr?: string;
  cnt_of_human?: number;
  arr_of_human?: number[];
}
