/** A person's name as the site writes it everywhere: the surname first (PE-26).
 *  Kept apart from contactFields so the always-loaded layout does not pull zod into the main chunk (PF-03). */
export const personName = (person: { surname?: string | null; name?: string | null }) =>
  [person.surname, person.name].map((part) => part?.trim()).filter(Boolean).join(" ");
