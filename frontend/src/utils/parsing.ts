import { type ContactInfo } from "../components/ContactChip/ContactChip";

export const stringifyContent = (info: ContactInfo): string => {
  return [
    `Фамилия: ${info.surname}`,
    `Имя: ${info.name}`,
    `Отчество: ${info.patronymic}`,
    `ККР: ${info.kkr_name}`,
    `Группа: ${info.group}`,
    `Место жительства: ${info.residence}`,
    `Блоки: ${info.blocks}`,
    `Телефон: ${info.phone}`,
    `ВК: ${info.vk}`,
    `ТГ: ${info.tg}`,
    `Почта: ${info.email}`,
    `Форма обучения: ${info.education}`,
    `Фото: ${info.photo_url || ''}`,
  ].join('\n');
};


export const parseContent = (content: string): ContactInfo => {
  const lines = content.split('\n');
  const info: ContactInfo = {
    surname: '',
    name: '',
    patronymic: '',
    kkr_name: '',
    group: '',
    residence: '',
    blocks: '',
    phone: '',
    vk: '',
    tg: '',
    email: '',
    education: '',
    photo_url: '',
  };

  const keyMap: Record<string, keyof ContactInfo> = {
    'фамилия': 'surname',
    'имя': 'name',
    'отчество': 'patronymic',
    'ккр': 'kkr_name',
    'группа': 'group',
    'место жительства': 'residence',
    'блоки': 'blocks',
    'телефон': 'phone',
    'вк': 'vk',
    'тг': 'tg',
    'телеграмм': 'tg',
    'почта': 'email',
    'email': 'email',
    'форма обучения': 'education',
    'фото': 'photo_url',
  };

  lines.forEach(line => {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim().toLowerCase();
      const value = parts.slice(1).join(':').trimStart();
      if (keyMap[key]) {
        info[keyMap[key]] = value;
      }
    }
  });

  return info;
};

export const extractContactsFromMarkdown = (mdText: string): ContactInfo[] => {
  // Ищем всё, что находится между ```chip и ```
  // \s*(\r?\n)? позволяет корректно обрабатывать разные переносы строк и пробелы после ```chip
  const regex = /```chip\s*(\r?\n)?([\s\S]*?)```/g;
  const contacts: ContactInfo[] = [];
  let match;

  while ((match = regex.exec(mdText)) !== null) {
    const rawContent = match[2]; // Текст внутри чипа (группа 2)
    const parsedInfo = parseContent(rawContent);
    contacts.push(parsedInfo);
  }

  return contacts;
};

export const parseProfileUrl = (input: string, prefix: string): string => {
  if (!input) return "";
  let cleanInput = input.trim();

  if (cleanInput.startsWith('@')) {
    cleanInput = cleanInput.slice(1).trim();
  }
  if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
    return cleanInput;
  }
  cleanInput = cleanInput.replace(/^www\./i, '');

  if (cleanInput.startsWith(prefix)) {
    return `https://${cleanInput}`;
  }
  const separator = prefix.endsWith('/') || cleanInput.startsWith('/') ? '' : '/';
  
  return `https://${prefix}${separator}${cleanInput}`;
};