// The secret scan. kb syncs every note to a git remote, so a secret in a note leaks to every
// machine and stays in the history. Each write of new note text runs this scan first.

import { KbError } from "./note.ts";

const URL_PASSWORD = "a password in a URL";

/**
 * Token formats with a fixed shape. Each pattern needs the full length of a real token, so a note
 * that names a format ("GitHub tokens start with ghp_") still saves.
 */
const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "a private key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { kind: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { kind: "an OpenAI API key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/ },
  { kind: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{20,}/ },
  { kind: "a Slack webhook", re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/ },
  { kind: "a Stripe key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { kind: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "an npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "a SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: "a Hugging Face token", re: /\bhf_[A-Za-z]{34}\b/ },
  { kind: "a JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // A password in a URL, as in scheme://user:password@host. A placeholder such as <password> or
  // ${PASSWORD} is not a secret, so the password must be plain characters. The user can be empty,
  // as in redis://:password@host. Bounded repeats keep a long line from a slow match.
  { kind: URL_PASSWORD, re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,100}:[A-Za-z0-9._~%!*+-]{6,}@/i },
];

/**
 * A secret given to a name, as in API_KEY=... or "password": "...". The name can be longer
 * (GITHUB_TOKEN), and the keyword matches inside it, so the pattern needs no prefix.
 */
const ASSIGNED = /(?:api[_-]?key|secret|token|passwd|password|access[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{20,})/gi;

/**
 * A value counts only when it looks random: upper case, lower case and digits together, or a long
 * hex string. A path, a UUID, a lowercase slug and a reference to an environment variable do not.
 */
function looksRandom(value: string): boolean {
  if (/^(?:process\.env|import\.meta\.env|os\.environ)\./.test(value)) return false;
  if (/^[0-9a-f]{32,}$/.test(value)) return true;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

/** The first secret in a text: what kind, and on which line. */
export function findSecret(text: string): { kind: string; line: number } | null {
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const { kind, re } of PATTERNS) if (re.test(line)) return { kind, line: i + 1 };
    for (const match of line.matchAll(ASSIGNED)) if (looksRandom(match[1]!)) return { kind: "a secret value", line: i + 1 };
  }
  return null;
}

/** A line break: as it is, or written out as in a JSON file. */
const BREAK = String.raw`(?:\r?\n|\\r\\n|\\n)`;
/** A run of key material that stands alone. A word of a sentence is shorter, or has other characters. */
const BASE64 = String.raw`(?:[A-Za-z0-9+/]{16,}={0,2}|[A-Za-z0-9+/]+={1,2}|=[A-Za-z0-9+/]{4})(?=\s|\\[nr]|["']|$)`;
/** An armor header, which is a whole line: `Proc-Type`, `DEK-Info`, the `Version` and `Comment` of a PGP block. */
const HEADER = String.raw`[A-Za-z][A-Za-z0-9-]*: [^\r\n\\]*(?=${BREAK})`;
/**
 * A private key. `findSecret` sees the first line only, and the rest has no shape of its own: a
 * key can start with armor headers, and it can come as lines or as one line with `\n` written out.
 * With an END line, all from BEGIN to END goes. No second BEGIN stands between them, so a text
 * that only names the first line does not reach the END of a later key.
 * With no END line the key was cut, or a sentence only names its first line. Then the BEGIN mark
 * goes, and after it only what looks like a key: the lines of base64 and of armor headers that
 * follow it, with the empty lines between them, and base64 on the same line. A sentence stays.
 */
const KEY_BLOCK = new RegExp(
  String.raw`-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----(?:(?:(?!-----BEGIN )[\s\S])*?-----END \1-----|(?:(?:[ \t]*${BREAK})+[ \t]*(?:${BASE64}|${HEADER})|[ \t]+${BASE64})*)`,
  "g",
);

const masked = (kind: string) => `<masked: ${kind}>`;
/** What stands in for a line that still holds a secret after the masks. */
export const LINE_LEFT_OUT = "<a line that held a secret was left out>";

function maskLine(line: string): string {
  let out = line;
  for (const { kind, re } of PATTERNS) {
    // A URL keeps its scheme, user and host: only the password goes.
    out = out.replace(new RegExp(re.source, `${re.flags}g`), (match) => (kind === URL_PASSWORD ? `${match.slice(0, match.lastIndexOf(":") + 1)}${masked("a password")}@` : masked(kind)));
  }
  // The name stays, so a reader still sees which value it was.
  out = out.replace(ASSIGNED, (match, value: string) => (looksRandom(value) ? `${match.slice(0, match.length - value.length)}${masked("a secret value")}` : match));
  // The masks and the scan read the same patterns. A line that still matches is not written at all.
  return findSecret(out) ? LINE_LEFT_OUT : out;
}

/**
 * A text with each secret that `findSecret` knows changed to a placeholder that names its kind.
 * For text that kb shows to an agent and did not write itself, such as an old session. No line of
 * the result holds a secret pattern: `findSecret` gives null for it.
 */
export function maskSecrets(text: string): string {
  return maskKeys(text).split("\n").map(maskLine).join("\n");
}

/**
 * Only the mask for a private key. It reads the lines of a text, so a caller that joins the lines
 * of a text into one runs it first.
 */
export function maskKeys(text: string): string {
  return text.replace(KEY_BLOCK, masked("a private key"));
}

/**
 * Text of a tool call and of its output is not text that a person wrote for a reader, so a short
 * or plain value there is a secret as often as a long random one. These masks are wider than the
 * scan: a note may say `token: abc`, and a command line that says it shows a real token.
 */
const AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*["']?)((?:(?:bearer|basic|token|digest|negotiate|apikey|bot)[ \t]+)?)([^\s"',;]+)/gi;
const AUTH_SCHEME = /\b(bearer|basic)([ \t]+)([A-Za-z0-9._~+/=_-]{6,})/gi;
/**
 * A name, then `=` or `:`, or only a space as after a flag (`--token abc`). The name is taken
 * whole and from its first character, so a long run of letters costs one pass. The value comes
 * after it: bare, or in quotes.
 */
const NAME = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*|[ \t]+)/g;
const VALUE = /"([^"]*)"|'([^']*)'|([^\s"'`,;&|)<>]+)/y;
/**
 * A name that says its value is a secret: it ends with the word. `KeyError`, `max_tokens` and
 * `monkey` do not, and `--key-file` names a file.
 */
const saysSecret = (name: string) => /(?:secret|token|passw(?:or)?d|pwd|credentials?|api[_-]?key|(?:^|[_.-])(?:key|auth))$/i.test(name) || /[a-z0-9]Key$/.test(name);
/** The flag that takes `name:password`, as in `curl -u` and `--proxy-user`. */
const USER_FLAG = /^-(?:u|-(?:[a-z-]+-)?user)$/;
/** The user and the group of `docker run -u 1000:1000` are no name and password. */
const NUMBERS = /^\d+:\d+$/;
/** A password in a URL, of any length. The scan of a note wants 6 characters, and a command has `admin:pw@host`. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,100}:)([^\s/@]+)@/gi;
/**
 * `-p` with its value glued on is the password of a mysql client and of sshpass. For psql it is
 * the port, so digits stay there. Other commands join their short flags (`cp -pr`), so only a
 * line that names such a client is read.
 */
const GLUED_PASSWORD = /\b((mysql|mariadb|mycli|sshpass|psql|pg_)[\w-]*[^\n|;&]{0,200}?\s-p)(?:"([^"]*)"|'([^']*)'|([^\s"'`|;&-][^\s"'`|;&]*))/gi;

/** A value that names a secret and holds none: a variable, a placeholder, or a mask that is there already. */
const reference = (value: string) => value === "" || /^[$<{%]/.test(value) || /^(?:process\.env|import\.meta\.env|os\.environ)\b/.test(value);
/** One plain word, as in "basic authentication". */
const plainWord = (value: string) => /^[A-Z]?[a-z]+$/.test(value);

/**
 * `maskSecrets`, and then the wider masks for a tool call and its output, for a value of any
 * length: the value of an authorization header or of a Bearer or Basic scheme, the password in a
 * URL, the password glued to `-p` of a mysql client, and what `maskNamed` takes.
 */
export function maskToolText(text: string): string {
  const headers = maskSecrets(text)
    .replace(AUTH_HEADER, (match, head: string, scheme: string, value: string) => (reference(value) ? match : `${head}${scheme}${masked("a credential")}`))
    .replace(AUTH_SCHEME, (match, scheme: string, gap: string, value: string) => (plainWord(value) ? match : `${scheme}${gap}${masked("a credential")}`))
    .replace(URL_USERINFO, (match, head: string, value: string) => (reference(value) ? match : `${head}${masked("a password")}@`))
    .replace(GLUED_PASSWORD, (match, head: string, client: string, double?: string, single?: string, bare?: string) => {
      const value = double ?? single ?? bare ?? "";
      const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
      return reference(value) || (/^p/i.test(client) && /^\d+$/.test(value)) ? match : `${head}${quote}${masked("a password")}${quote}`;
    });
  return maskNamed(headers);
}

/**
 * Mask the value given to each name that says it is a secret: with `=` or `:`, or after a flag
 * with a space (`--token abc`). Mask the password of `-u name:password` too.
 */
function maskNamed(text: string): string {
  let out = "";
  let done = 0;
  for (const match of text.matchAll(NAME)) {
    const [whole, name, sign] = match as unknown as [string, string, string];
    if (match.index < done) continue;
    const flag = name.startsWith("-");
    const user = flag && USER_FLAG.test(name);
    const spaced = !/[:=]/.test(sign);
    // A space gives a value only to a flag: "the token abc" is a sentence. `--no-password` takes none.
    if (!(user || saysSecret(name)) || (spaced && (!flag || /^--?no-/.test(name)))) continue;
    VALUE.lastIndex = match.index + whole.length;
    const value = VALUE.exec(text);
    const inner = value ? (value[1] ?? value[2] ?? value[3] ?? "") : "";
    // After a space, a word that starts with `-` is the next flag.
    if (!value || reference(inner) || (spaced && inner.startsWith("-"))) continue;
    const quote = value[1] !== undefined ? '"' : value[2] !== undefined ? "'" : "";
    let hidden = masked("a secret value");
    if (user) {
      // The name stays. A value with no colon is a name only, and `-u redis://host` is a URL.
      const colon = inner.indexOf(":");
      if (colon < 0 || inner.startsWith("//", colon + 1) || NUMBERS.test(inner) || reference(inner.slice(colon + 1))) continue;
      hidden = `${inner.slice(0, colon + 1)}${masked("a password")}`;
    }
    out += `${text.slice(done, match.index)}${name}${sign}${quote}${hidden}${quote}`;
    done = VALUE.lastIndex;
  }
  return out + text.slice(done);
}

/**
 * Stop a write whose new text holds a secret. fields maps a name ("body", "rule") to its text, or
 * to a list such as the anchors. The error names the kind and the place, never the secret itself.
 */
export function rejectSecrets(fields: Record<string, unknown>, what: string): void {
  for (const [field, value] of Object.entries(fields)) {
    const list = Array.isArray(value);
    const text = list ? value.filter((v) => typeof v === "string").join("\n") : value;
    if (typeof text !== "string") continue;
    const found = findSecret(text);
    if (!found) continue;
    const where = list ? `${field}, item ${found.line}` : text.includes("\n") ? `${field}, line ${found.line}` : field;
    throw new KbError(
      `${what} looks like it holds ${found.kind} (${where}). kb syncs every note to git, so it saves no secret. ` +
        "Write a placeholder such as <token>, or say where the secret lives.",
    );
  }
}
