// The secret scan. kb syncs every note to a git remote, so a secret in a note leaks to every
// machine and stays in the history. Each write of new note text runs this scan first.

import { KbError } from "./note.ts";

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
  // ${PASSWORD} is not a secret, so the password must be plain characters.
  { kind: "a password in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[A-Za-z0-9._~%!*+-]{6,}@/i },
];

/**
 * A secret given to a name, as in API_KEY=... or "password": "...". A value counts only when it is
 * long and mixes letters and digits, so prose and placeholders do not match.
 */
const ASSIGNED = /\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|passwd|password|access[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{20,})/gi;
const looksRandom = (value: string) => /[A-Za-z]/.test(value) && /\d/.test(value);

/** The first secret in a text: what kind, and on which line. */
export function findSecret(text: string): { kind: string; line: number } | null {
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const { kind, re } of PATTERNS) if (re.test(line)) return { kind, line: i + 1 };
    for (const match of line.matchAll(ASSIGNED)) if (looksRandom(match[1]!)) return { kind: "a secret value", line: i + 1 };
  }
  return null;
}

/**
 * Stop a write whose new text holds a secret. fields maps a name ("body", "rule") to its text. The
 * error names the kind and the place, never the secret itself.
 */
export function rejectSecrets(fields: Record<string, unknown>, what: string): void {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;
    const found = findSecret(value);
    if (!found) continue;
    const where = value.includes("\n") ? `${field}, line ${found.line}` : field;
    throw new KbError(
      `${what} looks like it holds ${found.kind} (${where}). kb syncs every note to git, so it saves no secret. ` +
        "Write a placeholder such as <token>, or say where the secret lives.",
    );
  }
}
