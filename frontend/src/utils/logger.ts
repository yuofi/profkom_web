/* eslint-disable @typescript-eslint/no-explicit-any */
import { env } from "./env";

const isDevelopment =
  env.VITE_ENVIRONMENT === "development" ||
  // В случае опечатки в .env (как было в запросе VITE_ENVIROMENT)
  import.meta.env.VITE_ENVIROMENT === "development";

export const logger = {
  log: (...args: any[]) => {
    if (isDevelopment) {
      console.log(...args);
    }
  },
  warn: (...args: any[]) => {
    if (isDevelopment) {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
    if (isDevelopment) {
      console.error(...args);
    }
  },
  info: (...args: any[]) => {
    if (isDevelopment) {
      console.info(...args);
    }
  },
  debug: (...args: any[]) => {
    if (isDevelopment) {
      console.debug(...args);
    }
  },
  table: (...args: any[]) => {
    if (isDevelopment) {
      console.table(...args);
    }
  },
  trace: (...args: any[]) => {
    if (isDevelopment) {
      console.trace(...args);
    }
  },
};
