/**
 * Local secret scanner over *added* lines. Pure, offline. Findings are redacted before display.
 * The goal is a useful warning, not a security product: patterns are conservative to keep noise low.
 */

export interface SecretPattern {
  id: string;
  label: string;
  re: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'aws-access-key', label: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-pat', label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/ },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'private-key', label: 'Private key block', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-key', label: 'Stripe key', re: /\b(sk|rk)_(live|test)_[0-9A-Za-z]{16,}\b/ },
  { id: 'openai-key', label: 'OpenAI-style key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'anthropic-key', label: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { id: 'jwt', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'generic-assignment', label: 'Credential assignment', re: /\b(api[_-]?key|secret|token|passwd|password|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
  { id: 'url-credentials', label: 'Credentials in URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{4,}@[^\s/]+/i },
];

export interface SecretFinding {
  patternId: string;
  label: string;
  /** 1-based line in the *current* file */
  line: number;
  /** the matched text with the middle masked */
  redacted: string;
}

const PLACEHOLDER = /(example|placeholder|your[_-]?|xxx|changeme|<[^>]+>|\$\{|%s|dummy|sample|test_key|000000)/i;

/** Scans lines (with their 1-based numbers) and returns redacted findings. */
export function scanSecrets(lines: { line: number; text: string }[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { line, text } of lines) {
    if (text.length > 4000) continue; // minified / data lines: skip
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(text);
      if (!m) continue;
      if (PLACEHOLDER.test(m[0])) continue;
      out.push({ patternId: p.id, label: p.label, line, redacted: redact(m[0]) });
      break; // one finding per line is enough
    }
  }
  return out;
}

export function redact(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return '****';
  return `${t.slice(0, 4)}…${t.slice(-3)} (${t.length} chars)`;
}
