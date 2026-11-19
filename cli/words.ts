// Words of a text as the search and the neighbor check compare them: lowercase, with no stop
// word, and cut to a stem so that the forms of one word agree.

export const STOP_WORDS = new Set(["a", "an", "the", "is", "are", "be", "to", "of", "in", "on", "at", "for", "and", "or", "with", "by", "it", "its", "this", "that", "not", "no", "do", "does", "use", "uses", "when", "from", "as"]);

const VOWEL = /[aeiouy]/;
const isVowel = (letter: string | undefined) => letter !== undefined && VOWEL.test(letter);

/** The vowel groups of a word: "control" has 2. The u of "qu" is no vowel. */
const syllables = (word: string) => word.replace(/qu/g, "q").match(/[aeiouy]+/g)?.length ?? 0;

/**
 * Words that only look like a plural, a past or an -ing form. A singular in s is here when its
 * plural takes "es" ("aliases"), or when the cut gives another word ("news", "https").
 */
const AS_IS = new Set([
  ...["alias", "atlas", "axis", "bias", "bonus", "bus", "campus", "canvas", "census", "consensus", "corpus", "focus", "gas", "https", "lens", "news", "status", "virus"],
  ...["embed", "hundred", "evening", "setting"],
]);

/** A plural that no rule gives. */
const IRREGULAR: Record<string, string> = { indices: "index", matrices: "matrix", vertices: "vertex" };

/** Stems of a past or an -ing form whose base ends in e against the rules of `base`: "cached" is "cache". */
const SILENT_E = new Set([
  ...["cach", "chang", "exchang", "rang", "arrang", "challeng", "creat", "recreat", "guid", "rout", "past", "tast", "wast"],
  ...["delet", "complet", "promot", "denot", "ignor", "restor", "explor", "invit", "rewrit", "overwrit"],
]);

/** The last two letters of a stem of two syllables or more whose base has no e: "open", "edit", "cancel". */
const NO_E = /(er|or|en|on|an|it|et|ot|al|el|op)$/;

/** "retries" gives "retry", "boxes" gives "box" and "apis" gives "api". */
function singular(word: string): string {
  // No plural ends in ss, ous or sis: "class", "previous", "analysis".
  if (!word.endsWith("s") || /(ss|ous|sis)$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("es")) {
    const rest = word.slice(0, -2);
    const takesEs = AS_IS.has(rest) || /(ss|x|sh|zz)$/.test(rest) || (rest.endsWith("ch") && !SILENT_E.has(rest)) || (rest.endsWith("o") && word.length > 5);
    if (takesEs) return rest;
  }
  return word.slice(0, -1);
}

/**
 * The base of a past or an -ing form, from what is left after the cut: "stopp" is "stop", "shar"
 * is "share" and "fail" stays. English writes a base that ends in e without it before -ed and
 * -ing, so the rules say where the e was. A wrong answer here only misses a match: it joins no
 * two words.
 */
function base(rest: string): string {
  const last = rest.at(-1)!;
  const before = rest.at(-2);
  if (AS_IS.has(rest) || "aeio".includes(last)) return rest;
  if (SILENT_E.has(rest)) return `${rest}e`;
  // A doubled consonant: "stopped" is "stop". A double f, l, s or z is part of the base, as in "diff", "call", "miss" and "buzz".
  if (last === before) return rest.length > 3 && !"flsz".includes(last) ? rest.slice(0, -1) : rest;
  if ("hwxy".includes(last)) return rest;
  // No base ends in these letters: "forced", "saved", "queued", "sized", "parsed". "synced" is "sync".
  if ("cvuzs".includes(last)) return rest.endsWith("ync") ? rest : `${rest}e`;
  if (last === "g") return before === "n" ? rest : `${rest}e`;
  if (!isVowel(before)) {
    // "handled" is "handle". "curled" is "curl", and "crawled" is "crawl".
    return last === "l" && !"rw".includes(before!) ? `${rest}e` : rest;
  }
  // Two vowels before the consonant, as in "failed" and "loaded". The u of "qu" is no vowel.
  if (isVowel(rest.at(-3)) && !(rest.at(-3) === "u" && rest.at(-4) === "q")) {
    return /[iu]at$/.test(rest) ? `${rest}e` : rest;
  }
  // One vowel and one consonant. A base of one syllable without e doubles its consonant, so this one has the e: "noted".
  return syllables(rest) > 1 && NO_E.test(rest) ? rest : `${rest}e`;
}

/**
 * A light stemmer for inflected forms only: the plural, the past and the -ing form. "retries",
 * "retried" and "retrying" give "retry". "cache", "caches", "cached" and "caching" give "cache".
 * A stem keeps its final e, so "note" is not "not" and "core" is not "cors". It leaves derived
 * words alone ("migrate" and "migration" stay apart), so it joins few words that differ in
 * meaning. A short word, and a word with a digit, stays as it is.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length < 4 || /\d/.test(w) || AS_IS.has(w)) return w;
  // The plural first, so "retries" goes on as "retry" does.
  w = IRREGULAR[w] ?? singular(w);
  if (AS_IS.has(w)) return w;
  // "cookie" and "cookies" agree, as "copy" and "copies" do.
  if (/(ie|ied)$/.test(w) && w.length > 4) w = `${w.replace(/ied?$/, "")}y`;
  // The rest needs a vowel, so "string" is not "str".
  else if (w.endsWith("ing") && w.length > 5 && VOWEL.test(w.slice(0, -3))) w = base(w.slice(0, -3));
  else if (w.endsWith("ed") && !w.endsWith("eed") && w.length > 4 && VOWEL.test(w.slice(0, -2))) w = base(w.slice(0, -2));
  // "control" and "controlled" agree, and "install" and "installed". "call" keeps its ll.
  return w.endsWith("ll") && syllables(w) > 1 ? w.slice(0, -1) : w;
}

/** The words of a text: runs of letters and digits, in lowercase. An accent goes, so "migração" is one word. */
export function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[a-z0-9]+/g) ?? [];
}

/** The words that carry meaning: no stop word, and no single character. */
export function meaningWords(text: string): string[] {
  return words(text).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** The stems of the words that carry meaning. */
export function stems(text: string): string[] {
  return meaningWords(text).map(stem);
}
