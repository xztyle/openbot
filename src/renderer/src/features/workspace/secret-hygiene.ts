/*
 * Finds keys, tokens and passwords that the reader pastes into a message, so the message that the
 * host stores and the agents read never holds them. The composer replaces each one with a short
 * marker and offers to save it in Secrets, where an agent finds it with `openbot.list_api_keys`.
 *
 * Only shapes that are almost never ordinary words count: a provider's key prefix, a private key
 * block, a JSON web token, or a value after a word such as "password:" or "token=". A false hit costs
 * the reader a resend; a miss stores the secret for good, so the shapes lean to finding.
 */

export interface FoundSecret {
  /** What the secret is, for the marker and the notice, such as "GitHub token". */
  label: string;
  /** A Secrets name to save it under, such as GITHUB_TOKEN. */
  name: string;
  value: string;
}

export interface SecretScan {
  /** The text with each secret replaced by its marker. The same text when nothing was found. */
  text: string;
  found: FoundSecret[];
}

interface SecretShape {
  label: string;
  name: string;
  pattern: RegExp;
}

// Prefixes first: a GitHub token after "token:" is named for GitHub, not as a generic token.
const SHAPES: readonly SecretShape[] = [
  {
    label: "private key",
    name: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )*PRIVATE KEY-----/gu,
  },
  {
    label: "GitHub token",
    name: "GITHUB_TOKEN",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/gu,
  },
  { label: "Anthropic key", name: "ANTHROPIC_API_KEY", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/gu },
  { label: "OpenAI key", name: "OPENAI_API_KEY", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/gu },
  { label: "Stripe key", name: "STRIPE_SECRET_KEY", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/gu },
  { label: "webhook secret", name: "WEBHOOK_SECRET", pattern: /\bwhsec_[A-Za-z0-9+/=_-]{24,}/gu },
  { label: "Slack token", name: "SLACK_TOKEN", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{20,}/gu },
  { label: "AWS key", name: "AWS_ACCESS_KEY_ID", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { label: "Google key", name: "GOOGLE_API_KEY", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/gu },
  { label: "Render key", name: "RENDER_API_KEY", pattern: /\brnd_[A-Za-z0-9]{24,}/gu },
  { label: "GitLab token", name: "GITLAB_TOKEN", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/gu },
  { label: "Linear key", name: "LINEAR_API_KEY", pattern: /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/gu },
  { label: "npm token", name: "NPM_TOKEN", pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu },
  { label: "Hugging Face token", name: "HF_TOKEN", pattern: /\bhf_[A-Za-z0-9]{30,}/gu },
  { label: "Meta token", name: "META_ACCESS_TOKEN", pattern: /\bEAA[A-Za-z0-9]{80,}/gu },
  { label: "Telegram bot token", name: "TELEGRAM_BOT_TOKEN", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/gu },
  {
    label: "access token",
    name: "ACCESS_TOKEN",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  },
];

/**
 * A value after a word that names a secret, in English, Spanish or Portuguese: `password: hunter22`,
 * `contraseña = Abc123!`, `api key: …`. The value has no spaces and at least 6 characters, so "the
 * password is in the vault" does not count. Group 1 is the word, group 2 the value.
 */
const LABELED =
  /\b(password|passwd|pwd|contraseña|contrasena|clave|senha|passcode|api[ _-]?key|secret|token|access[ _-]?token|client[ _-]?secret)\b\s*(?:is|es|é|=|:)\s*["'`]?([^\s"'`]{6,200})/giu;

/** Words that often follow "password:" in plain talk and are not a password. */
const NOT_A_VALUE = /^(?:required|incorrect|incorrecta|wrong|reset|changed|expired|hidden|oculto|oculta|\[)/iu;

function labeledShape(word: string): { label: string; name: string } {
  const lower = word.toLowerCase().replace(/[ _-]/gu, "");
  if (/^(?:password|passwd|pwd|contraseña|contrasena|clave|senha|passcode)$/u.test(lower))
    return { label: "password", name: "PASSWORD" };
  if (lower === "apikey") return { label: "API key", name: "API_KEY" };
  if (lower === "clientsecret") return { label: "client secret", name: "CLIENT_SECRET" };
  if (lower === "secret") return { label: "secret", name: "SECRET" };
  return { label: "token", name: "ACCESS_TOKEN" };
}

/** True when the value looks typed by hand, not a word: it mixes letters with digits or symbols. */
function looksLikeSecret(value: string): boolean {
  if (NOT_A_VALUE.test(value)) return false;
  if (/^https?:\/\//iu.test(value)) return false;
  return /[A-Za-z]/u.test(value) && /[^A-Za-z]/u.test(value);
}

/** Replaces the secrets in `text`. `marker` writes the text that stands where each one was. */
export function scanForSecrets(text: string, marker: (secret: FoundSecret) => string): SecretScan {
  const found: FoundSecret[] = [];
  const take = (secret: FoundSecret): string => {
    const known = found.find((item) => item.value === secret.value);
    if (!known) found.push(secret);
    return marker(known ?? secret);
  };
  let result = text;
  for (const shape of SHAPES)
    result = result.replace(shape.pattern, (value) => take({ label: shape.label, name: shape.name, value }));
  result = result.replace(LABELED, (whole, word: string, value: string) => {
    // A value that a shape above already replaced is a marker now.
    if (!looksLikeSecret(value)) return whole;
    const shape = labeledShape(word);
    return whole.slice(0, whole.length - value.length) + take({ ...shape, value });
  });
  return { text: result, found };
}

/** A Secrets name that `taken` does not hold yet: GITHUB_TOKEN, then GITHUB_TOKEN_2 and so on. */
export function freeSecretName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let index = 2; ; index += 1) {
    const candidate = `${name}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
