// Words of a text as the search and the neighbor check compare them: lowercase, with no stop
// word, and cut to a stem so that the forms of one word agree.

export const STOP_WORDS = new Set(["a", "an", "the", "is", "are", "be", "to", "of", "in", "on", "at", "for", "and", "or", "with", "by", "it", "its", "this", "that", "not", "no", "do", "does", "use", "uses", "when", "from", "as"]);

const VOWEL = /[aeiouy]/;

/** "stopp" gives "stop". A double l, s or z stays, as in "fall", "miss" and "buzz". */
function undouble(word: string): string {
  const last = word.at(-1)!;
  return word.length > 3 && last === word.at(-2) && !"aeioulsz".includes(last) ? word.slice(0, -1) : word;
}

/**
 * A light stemmer for inflected forms only: the plural, the past and the -ing form. "retries",
 * "retried" and "retrying" give "retry". "cache", "caches", "cached" and "caching" give "cach".
 * It leaves derived words alone ("migrate" and "migration" stay apart), so it joins few words
 * that differ in meaning. A short word, and a word with a digit, stays as it is.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length < 4 || /\d/.test(w)) return w;
  // The plural first, so "settings" goes on to "set" as "setting" does.
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ss|x|ch|sh|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  // The stem needs a vowel, so "string" is not "str".
  if (w.endsWith("ied") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ing") && w.length > 5 && VOWEL.test(w.slice(0, -3))) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && !w.endsWith("eed") && w.length > 4 && VOWEL.test(w.slice(0, -2))) w = undouble(w.slice(0, -2));
  // "share", "shared" and "sharing" must agree, so a final e goes too.
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** The words of a text: runs of letters and digits, in lowercase. */
export function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? [];
}

/** The stems of the words that carry meaning: no stop word, and no single character. */
export function stems(text: string): string[] {
  return words(text).filter((word) => word.length > 1 && !STOP_WORDS.has(word)).map(stem);
}
