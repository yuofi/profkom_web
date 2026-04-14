export interface LoginIn {
  user_name: string;
  password: string;
}

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
  user_name: string;
  password: string;
  kkr_score: number;
  group_number: string;
  blocks: string;
  banned?: boolean; 
  super_user?: boolean;
  admin?: boolean; 
}

// То, что приходит с бэкенда при запросе профиля
export interface UserOut {
  user_id: number;
  user_name: string;
  kkr_score: number;
  group_number: string;
  blocks: string;
  banned: boolean;
  super_user: boolean;
  admin: boolean;
}

// Данные контакта (используется при регистрации)
export interface ContactInfoIn {
  fio: string;
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
}


export interface ContactInfoOut extends ContactInfoIn {
  user_id: number;
}


export interface ProfileUpdate {
  fio?: string;
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
}

export interface ContactFilter {
  group_number?: string;
  blocks?: string;
  in_profcom?: boolean;
  budget?: boolean;
}

export interface GuideIn {
  title: string;
  owner_block: string;
  text: string;
  original_link?: string | null; 
}

export interface GuideOut extends GuideIn {
  guide_id: number;
}