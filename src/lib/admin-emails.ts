export const ADMIN_EMAILS: readonly string[] = [
  "jacob@themagnas.com",
  "mdm@pfasports.com",
  "esther@pfasports.com",
] as const;

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
