export const logger = {
  info: (message: string, payload?: unknown) => {
    console.log(`[INFO] ${new Date().toISOString()} ${message}`, payload ?? '');
  },
  warn: (message: string, payload?: unknown) => {
    console.warn(`[WARN] ${new Date().toISOString()} ${message}`, payload ?? '');
  },
  error: (message: string, payload?: unknown) => {
    console.error(`[ERROR] ${new Date().toISOString()} ${message}`, payload ?? '');
  }
};
