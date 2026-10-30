import hr from "../assets/team-logos/hr.png";
import it from "../assets/team-logos/it.png";
import bdns from "../assets/team-logos/bdns.png";
import ures from "../assets/team-logos/ures.png";
import video from "../assets/team-logos/video.png";
import decor from "../assets/team-logos/decor.png";
import design from "../assets/team-logos/design.png";
import leisure from "../assets/team-logos/leisure.png";
import purchase from "../assets/team-logos/purchase.png";
import exam from "../assets/team-logos/exam.png";
import instagram from "../assets/team-logos/instagram.png";
import info from "../assets/team-logos/info.png";
import creative from "../assets/team-logos/creative.png";
import aid from "../assets/team-logos/aid.png";
import union_reps from "../assets/team-logos/union-reps.png";
import warehouse from "../assets/team-logos/warehouse.png";
import sponsors from "../assets/team-logos/sponsors.png";
import writers from "../assets/team-logos/writers.png";
import technicians from "../assets/team-logos/technicians.png";
import photo from "../assets/team-logos/photo.png";
import career from "../assets/team-logos/career.png";

/** Cosmetic presets use only explicitly supplied aliases, never role inference. */
const normalized = (value: string) => value.normalize("NFC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^a-zа-я0-9]/g, "");
const presets: [string, string[]][] = [
  [hr, ["HR"]],
  [it, ["IT", "ИТ"]],
  [bdns, ["БДНС"]],
  [ures, ["УРЭС"]],
  [video, ["Видеолаба"]],
  [decor, ["Декораторы"]],
  [design, ["Дизайн"]],
  [leisure, ["Досуг"]],
  [purchase, ["Закупки"]],
  [exam, ["Зачёт"]],
  [instagram, ["Инстаграм", "Instagram"]],
  [info, ["Инфоблок", "Инфо"]],
  [creative, ["КГ", "Креативная группа"]],
  [aid, ["Матпомощь", "Материальная помощь"]],
  [union_reps, ["Профорги"]],
  [warehouse, ["Склад"]],
  [sponsors, ["Спонсоры"]],
  [writers, ["Сценаристы"]],
  [technicians, ["Техники"]],
  [photo, ["Фото", "Фотоблок"]],
];
const blockPresets = new Map(presets.flatMap(([image, aliases]) => aliases.map(alias => [normalized(alias), image] as const)));
export const blockLogo = (name: string | null | undefined): string | undefined => name ? blockPresets.get(normalized(name)) : undefined;
export const DAY_OF_CAREER_LOGO = career;
export function eventLogo(title: string | null | undefined): string | undefined {
  return title && /^(денькарьеры|дк)(20\d{2})?$/.test(normalized(title)) ? career : undefined;
}
