/** Up to `count` initials: the first letter or digit of each word, skipping words without one,
 *  so quotes and dashes never become an initial ("Хакатон «Код осени»" → "ХК"). */
export function initials(name: string, count = 2): string {
  return name.trim().split(/\s+/).map(word => word.match(/[\p{L}\p{N}]/u)?.[0]).filter((first): first is string => !!first)
    .slice(0, count).join("").toLocaleUpperCase("ru");
}
