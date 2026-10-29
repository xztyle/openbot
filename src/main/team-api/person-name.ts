/** The part of an email address before the `@`, or null for an empty one. */
export function emailLocalPart(email: string | null | undefined): string | null {
  const local = email?.trim().split("@", 1)[0]?.trim();
  return local || null;
}

/**
 * The name a channel shows for a team member: their name, else the start of their email address, as
 * the account menu names the signed-in account. A username that is an email address is shortened too.
 */
export function teamPersonName(member: { name: string | null; email: string | null; username: string }): string {
  return (
    member.name?.trim() ||
    emailLocalPart(member.email) ||
    (member.username.includes("@") ? emailLocalPart(member.username) : null) ||
    member.username
  );
}
