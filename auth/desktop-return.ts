/** Browser authorization can return to the desktop's fixed local endpoint only. */
export function desktopReturnUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/api\/local\/auth\/callback$/.exec(value);
  return match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535 ? value : null;
}
export const desktopStateValid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
