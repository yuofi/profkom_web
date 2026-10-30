import type { Decision } from "./api/contract";

export const decisionLabels: Record<Decision, string> = {
  golden_red_bull: "Золотой Red Bull",
  kick_warning: "Предупреждение о кике",
  kick: "Кик",
  nice: "Найс",
};

export const decisionDescriptions: Partial<Record<Decision, string>> = {
  nice: "Добровольный уход из Профкома по личным причинам.",
  kick: "Принудительное исключение из Профкома за недостаточную работу.",
};

export const decisionTitle = (value: Decision) => decisionDescriptions[value]
  ? `${decisionLabels[value]} — ${decisionDescriptions[value]}`
  : decisionLabels[value];
