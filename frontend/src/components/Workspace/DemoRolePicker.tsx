import { isDemoMode } from "../../utils/demoData";
import s from "./WorkspaceLayout.module.css";
const roles = [
  ["organizer", "Организатор"],
  ["leader", "Руководитель"],
  ["hr", "Мастер HR"],
  ["hr-deputy", "Зам мастера HR"],
  ["chair", "Председатель"],
  ["chair-deputy", "Зам председателя"],
  ["editor", "Редактор"],
  ["pending", "Ожидание одобрения"],
  ["rejected", "Отказ регистрации"],
  ["archived", "Архивный аккаунт"],
  ["multi", "Несколько ролей"],
];
// The VK link of the demo account (mocks/transport.ts, MockBotScenario); «По роли»: a
// pending account has not linked the bot yet, an active one has.
const bots = [
  ["", "По роли"],
  ["ok", "Привязан"],
  ["none", "Не привязан"],
  ["denied", "Сообщения запрещены"],
  ["blocked", "Срок прошёл"],
  ["off", "Выключен"],
];
export function DemoRolePicker() {
  if (!import.meta.env.DEV || !isDemoMode) return null;
  return (
    <div className={s.demo}>
      Демонстрационный режим
      <label>
        Роль
        <select
          aria-label="Демонстрационная роль"
          value={
            sessionStorage.getItem("profkom-demo-role") ??
            import.meta.env.VITE_DEMO_ROLE ??
            "organizer"
          }
          onChange={(e) => {
            sessionStorage.setItem("profkom-demo-role", e.target.value);
            window.location.assign("/");
          }}
        >
          {roles.map(([role, title]) => (
            <option key={role} value={role}>
              {title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Сценарий
        <select
          aria-label="Демонстрационный сценарий"
          value={sessionStorage.getItem("profkom-demo-scenario") ?? "normal"}
          onChange={(e) => {
            sessionStorage.setItem("profkom-demo-scenario", e.target.value);
            window.location.assign("/");
          }}
        >
          <option value="normal">Обычная работа</option>
          <option value="empty">Пустые списки</option>
          <option value="error">Сбой сервиса</option>
          <option value="conflict">Конфликт сохранения</option>
        </select>
      </label>
      <label>
        Бот ВКонтакте
        <select
          aria-label="Демонстрационная привязка бота"
          value={sessionStorage.getItem("profkom-demo-bot") ?? ""}
          onChange={(e) => {
            sessionStorage.setItem("profkom-demo-bot", e.target.value);
            window.location.assign("/");
          }}
        >
          {bots.map(([value, title]) => (
            <option key={value} value={value}>
              {title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
