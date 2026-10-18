export type Values = Record<string, string | string[]>;
export const text = (values: Values, name: string) => String(values[name] ?? '').trim();
export const number = (values: Values, name: string) => Number(text(values, name));
export const ids = (values: Values, name: string) => (Array.isArray(values[name]) ? values[name] : [String(values[name])]).filter(Boolean).map(Number);
