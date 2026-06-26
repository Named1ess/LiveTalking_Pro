export const CLog = {
  debug: (...message: unknown[]): void => console.debug("[dycast]", ...message),
  info: (...message: unknown[]): void => console.info("[dycast]", ...message),
  warn: (...message: unknown[]): void => console.warn("[dycast]", ...message),
  error: (...message: unknown[]): void => console.error("[dycast]", ...message),
};
