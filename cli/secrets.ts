// The secret scan. kb syncs every note to a git remote, so a secret in a note leaks to every
// machine and stays in the history. Each write of new note text runs this scan first.

import { KbError } from "./note.ts";

const URL_PASSWORD = "a password in a URL";

/** A match of a shape: where it starts, its text, and the named groups of the regex. */
interface Hit {
  index: number;
  text: string;
  groups: Record<string, string | undefined>;
}

/**
 * A shape of a secret. `re` matches it. A shape that needs more than a regex has `cut`, which
 * ends the match early, and `ok`, which reads the match and the whole original line. The part of
 * the match in the group named `keep` stays when the mask replaces it, so a reader still sees the
 * name or the header that held the secret.
 *
 * Two uses read a shape. The scan of a note (`mask` is false) may let an example of a doc or a
 * local dev value through, as a note may talk about secrets. The mask of a transcript (`mask` is
 * true) leans to masking: it makes no such exemption, and it shows only what is no secret at all.
 */
interface Shape {
  kind: string;
  re: RegExp;
  cut?: (hit: Hit, line: string) => string;
  ok?: (hit: Hit, line: string, mask: boolean) => boolean;
}

/**
 * A value that names a secret and holds none: `<token>`, a `<masked: ...>` mask that is there
 * already, `${PASS}`, `$PASS`, `$(cmd)`, `{{ pass }}`, `%PASS%`, `***` and `process.env.X`. A `$`
 * name is a reference only in the style of an environment variable (`$DB_PASS`): `$uperSecret2024`
 * is a password. A value that only starts with `*`, `%` or `{` is a password too: `*Hunter2024`.
 */
const isReference = (value: string) =>
  /^(?:<[\w:. -]*(?:>|$)|\$(?:[{(]|[A-Z_][A-Z0-9_]*$|\d+$|[@*#?!-]$)|\{\{|%[A-Za-z_]\w*%$|\*{3,}$)/.test(value) || /^(?:process\.env|import\.meta\.env|os\.environ)\b/.test(value);

/**
 * A value counts only when it looks random: upper case, lower case and digits together, or a long
 * hex string. A path, a UUID, a lowercase slug and a reference to an environment variable do not.
 */
function looksRandom(value: string): boolean {
  if (isReference(value)) return false;
  if (/^[0-9a-f]{32,}$/.test(value)) return true;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

/** The start of an authorization header, the words that can follow it, and the characters of a token. One rule for the scan and for the tool text. */
const AUTH_HEAD = String.raw`authorization["']?\s*[:=]\s*["']?`;
const AUTH_WORDS = "bearer|basic|token|digest|negotiate|apikey|bot";
const TOKEN_CHARS = String.raw`A-Za-z0-9._~+/=_-`;

/** The base64 of `name:password`. A word that is no base64, or that holds no colon once decoded, is not one. */
function isBasicLogin(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value && /^[^:\x00-\x1f\x7f]*:[^\x00-\x1f\x7f]+$/.test(decoded.toString("utf8"));
}

/** A token after a header or a scheme: random, or long with letters and digits, as a hex or base64 token is. */
const looksToken = (value: string) => !isReference(value) && (looksRandom(value) || (value.length >= 32 && /[a-z]/i.test(value) && /\d/.test(value) && !SLUG.test(value)));
/** Lower case words and digits with `-`, `_` or `.` between them, as in a file name or a title: `k8s-cluster-setup-2024`. A UUID is one too. */
const SLUG = /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/;

/** The passwords that a doc or an example writes, which hold no secret, also with a number after: `Password1`. */
const PLACEHOLDER = /^(?:pass(?:word)?|passwd|pwd?|secret|changeme|example|test|x+|\.+)\d*$/i;
/**
 * A value that is code, not a secret: a call (`z.string().min(8)`, `sha256(pw)`), a dotted path
 * (`args.password2`) or a SOPS value (`ENC[AES256_GCM,...`). Only the scan of a note lets it through.
 */
const CODE = /^(?:[A-Za-z_$][\w$.]*\(|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$|ENC\[)/;
/** A path, as in `password: /run/secrets/db`, names where the secret is. */
const PATH = /^(?:\/|\.{1,2}\/|~\/)/;
/**
 * The host of a URL that a note can show with a made-up or a local password: the machine itself,
 * a name that is reserved for examples and tests (RFC 2606, 6761), or a documentation address (RFC 5737).
 */
const LOCAL_HOST = /^(?:localhost|[^.]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|(?:[^.]+\.)*example(?:\.(?:com|net|org))?|[^.]+\.(?:example|test|invalid)|192\.0\.2\.\d{1,3}|198\.51\.100\.\d{1,3}|203\.0\.113\.\d{1,3})$/i;

/**
 * Token formats with a fixed shape. Each pattern needs the full length of a real token, so a note
 * that names a format ("GitHub tokens start with ghp_") still saves. A repeat with no upper bound
 * (`{30,}`) takes a whole value, so a mask never leaves a tail. Such a repeat runs over one class
 * from a fixed start, so each pass is linear and a long line cannot make a match slow.
 */
const SHAPES: Shape[] = [
  { kind: "a private key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { kind: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { kind: "an OpenAI API key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/ },
  { kind: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{20,}/ },
  { kind: "a Slack webhook", re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/ },
  { kind: "a Stripe key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}|\bwhsec_[A-Za-z0-9]{24,}/ },
  { kind: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: "a Google OAuth client secret", re: /\bGOCSPX-[A-Za-z0-9_-]{24,}/ },
  { kind: "an npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "a SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: "a Hugging Face token", re: /\bhf_[A-Za-z]{34}\b/ },
  { kind: "a Twilio key", re: /\bSK[0-9a-f]{32}\b/ },
  { kind: "an Azure key", re: /\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{30,}={0,2}/ },
  { kind: "a Shopify token", re: /\bshp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}\b/ },
  // `key-` and 32 hex characters is also a cache key or a hash, so the line must speak of a credential.
  { kind: "a Mailgun key", re: /\bkey-[0-9a-f]{32}\b/, ok: (_, line) => /mailgun|\bapi\b|secret|token|credential|passw|auth/i.test(line) },
  { kind: "a Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/ },
  { kind: "a DigitalOcean token", re: /\bdo[opr]_v1_[0-9a-f]{64}\b/ },
  { kind: "a JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // The secret half of an AWS key pair has no prefix: 40 characters of base64 on a line that says AWS.
  // A run in a URL path stays, and so does a commit id, which has no upper case.
  {
    kind: "an AWS secret key",
    re: /(?<![A-Za-z0-9/+.])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/,
    ok: ({ text }, line) => /[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text) && /(?<![a-z])aws(?![a-z])/i.test(line),
  },
  // The value of an authorization header, and of a Bearer or Basic scheme, as /kb:recover masks it.
  {
    kind: "a credential",
    re: new RegExp(String.raw`(?<keep>\b(?:${AUTH_HEAD}(?:(?:${AUTH_WORDS})[ \t]+)?|(?:bearer|basic)[ \t]+))[${TOKEN_CHARS}]{20,}`, "i"),
    ok: (h) => looksToken(h.text.slice(h.groups.keep!.length)),
  },
  // A short Basic value is the base64 of `user:password`, which is a credential at any length.
  {
    kind: "a credential",
    re: new RegExp(String.raw`(?<keep>\b${AUTH_HEAD}basic[ \t]+)[A-Za-z0-9+/]{4,}={0,2}(?![A-Za-z0-9+/=])`, "i"),
    ok: (h) => isBasicLogin(h.text.slice(h.groups.keep!.length)),
  },
  // A password given to its name, as in `password: hunter2hunter2`. A word or a slug is prose, so
  // the value needs a digit or a sign. A short value is a joke or an example as often as a secret.
  // The name can have a prefix (PGPASSWORD, dbPassword). In a query string the value ends at `&`,
  // and in the user and password of a URL it ends at `@`. The scan of a note lets a code value
  // (`z.string().min(8)`, `args.password2`, a SOPS value), a placeholder and a path through.
  {
    kind: "a password",
    re: /(?<keep>(?:passw(?:or)?d|pwd|passphrase)["']?\s{0,20}[:=]\s{0,20}["']?)[^\s"'`,;<>]{8,}/i,
    cut: (hit, line) => {
      // Only the text just before the name counts, so a long line is not read again for each hit.
      const before = line.slice(Math.max(0, hit.index - 300), hit.index);
      const keep = hit.groups.keep!;
      const value = hit.text.slice(keep.length);
      const stop = /\?[^\s#]*$/.test(before) ? value.indexOf("&") : /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i.test(before) ? value.indexOf("@") : -1;
      return stop < 0 ? hit.text : hit.text.slice(0, keep.length + stop);
    },
    ok: (hit, line, mask) => {
      const value = hit.text.slice(hit.groups.keep!.length);
      if (value.length < 8 || isReference(value) || !/[a-z]/i.test(value) || !/[\d!@#$%^&*+=?~]/.test(value) || !wholeName(hit, line)) return false;
      return mask || !(PLACEHOLDER.test(value) || PATH.test(value) || CODE.test(value));
    },
  },
  // A password in a URL, as in scheme://user:password@host. A placeholder such as <password>,
  // ${PASSWORD} or the word "password" is not a secret, so the password must be plain characters.
  // The scan of a note lets an example through: a password that is the user again, as in
  // postgres://postgres:postgres@localhost, a placeholder word, and any password on a local or
  // example host (localhost, 127.0.0.1, example.com), which is a dev setup. The mask of a
  // transcript hides every password that is no reference. The user can be empty, as in
  // redis://:password@host. The user is bounded, so a line of `x://` with no end is not a slow match.
  {
    kind: URL_PASSWORD,
    re: /(?<keep>\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,100}:)[A-Za-z0-9._~%!*+-]+@(?=(?<host>\[[^\]\s]*\]|[^\s/:?#@]*))/i,
    ok: (hit, _line, mask) => {
      const keep = hit.groups.keep!;
      const password = hit.text.slice(keep.length, -1);
      if (isReference(password)) return false;
      return mask || (!PLACEHOLDER.test(password) && password !== keep.slice(keep.indexOf("://") + 3, -1) && !LOCAL_HOST.test(hit.groups.host!));
    },
  },
];

/** The shapes, with each pattern also built once as a global regex, so a scan makes no regex per line. */
const PATTERNS = SHAPES.map((shape) => ({ ...shape, all: new RegExp(shape.re.source, `${shape.re.flags.replace("g", "")}g`) }));

/**
 * The name before a password keyword stays whole. `PGPASSWORD` and `dbPassword` end in the word, but
 * a lower case letter before `passwd` is part of another word, as in `chpasswd`.
 */
function wholeName(hit: Hit, line: string): boolean {
  const before = line[hit.index - 1];
  if (!before || !/[A-Za-z]/.test(before)) return true;
  const word = hit.text.slice(0, hit.text.search(/["'\s:=]/));
  if (word === word.toUpperCase()) return before === before.toUpperCase();
  return /^[A-Z][a-z]+$/.test(word) && before === before.toLowerCase();
}

/**
 * Each match of a shape in a text. `line` is the line before any mask, so a gate reads what was
 * written and not the masks of earlier shapes. `mask` is true for the mask of a transcript.
 */
function* matches(text: string, shape: (typeof PATTERNS)[number], line: string, mask: boolean): Generator<Hit> {
  for (const match of text.matchAll(shape.all)) {
    const hit: Hit = { index: match.index!, text: match[0], groups: match.groups ?? {} };
    if (shape.cut) hit.text = shape.cut(hit, line);
    if (!shape.ok || shape.ok(hit, line, mask)) yield hit;
  }
}

/**
 * A secret given to a name, as in API_KEY=... or "password": "...". The name can be longer
 * (GITHUB_TOKEN), and the keyword matches inside it, so the pattern needs no prefix.
 */
const ASSIGNED = /(?:api[_-]?key|secret|token|passwd|password|access[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{20,})/gi;

/** The kind of the first secret in one line, or null. `written` is the line before any mask, for the gate of a shape. */
function lineSecret(line: string, written = line): string | null {
  for (const shape of PATTERNS) if (!matches(line, shape, written, false).next().done) return shape.kind;
  for (const match of line.matchAll(ASSIGNED)) if (looksRandom(match[1]!)) return "a secret value";
  return null;
}

/** The first secret in a text: what kind, and on which line. */
export function findSecret(text: string): { kind: string; line: number } | null {
  for (const [i, line] of text.split("\n").entries()) {
    const kind = lineSecret(line);
    if (kind) return { kind, line: i + 1 };
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
  for (const shape of PATTERNS) {
    // The kept part stays. A URL keeps its scheme, user and host: only the password goes.
    let next = "";
    let done = 0;
    for (const hit of matches(out, shape, line, true)) {
      const keep = hit.groups.keep ?? "";
      const mask = shape.kind === URL_PASSWORD ? `${masked("a password")}@` : masked(shape.kind);
      next += `${out.slice(done, hit.index)}${keep}${mask}`;
      done = hit.index + hit.text.length;
    }
    out = next + out.slice(done);
  }
  // The name stays, so a reader still sees which value it was.
  out = out.replace(ASSIGNED, (match, value: string) => (looksRandom(value) ? `${match.slice(0, match.length - value.length)}${masked("a secret value")}` : match));
  // The masks and the scan read the same patterns. A line that still matches is not written at all.
  return lineSecret(out, line) ? LINE_LEFT_OUT : out;
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
const AUTH_HEADER = new RegExp(String.raw`\b(${AUTH_HEAD})((?:(?:${AUTH_WORDS})[ \t]+)?)([^\s"',;]+)`, "gi");
const AUTH_SCHEME = new RegExp(String.raw`\b(bearer|basic)([ \t]+)([${TOKEN_CHARS}]{6,})`, "gi");
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
/** A password in a URL, of any length and for any host: a command has `admin:pw@host`, and what a tool shows is not a note. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,100}:)([^\s/@]+)@/gi;
/**
 * `-p` with its value glued on is the password of a mysql client and of sshpass. For psql it is
 * the port, so digits stay there. Other commands join their short flags (`cp -pr`), so only a
 * line that names such a client is read.
 */
const GLUED_PASSWORD = /\b((mysql|mariadb|mycli|sshpass|psql|pg_)[\w-]*[^\n|;&]{0,200}?\s-p)(?:"([^"]*)"|'([^']*)'|([^\s"'`|;&-][^\s"'`|;&]*))/gi;

/** An empty value, or a reference. A `{` opens a JSON or a YAML value, and a whole array does too: no scalar. A `[` with no `]` is a password. */
const reference = (value: string) => value === "" || isReference(value) || value.startsWith("{") || /^\[.*\]$/.test(value);
/** A whole array after a name, as in `tokens: [a, b]`. The bare value stops at a comma, so this reads the text. */
const ARRAY = /\[[^\]\n]*\]/y;
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
    ARRAY.lastIndex = VALUE.lastIndex - value[0].length;
    if (value[3] !== undefined && inner.startsWith("[") && ARRAY.test(text)) continue;
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
