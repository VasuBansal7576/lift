const SECRET_KEY =
  /(?:token|password|secret|api[_-]?key|authorization|credential|cookie)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Drop secret-looking keys. Never returns key fragments. */
export function redactRecord(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSecretKey(key)) {
      out[key] = "<redacted>";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactRecord(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function stripSecretsFromText(text: string): string {
  return text
    .replace(/(Api-Key|Bearer|Token)\s+\S+/gi, "$1 <redacted>")
    .replace(
      /\b(FLAGSMITH_(?:ADMIN_API_TOKEN|API_KEY|SERVER_KEY|ENVIRONMENT_KEY)|GROQ_API_KEY|GEMINI_API_KEY|LIFT_LLM_API_KEY|LIFT_LLM_API_URL)=[^\s]+/gi,
      "$1=<redacted>",
    );
}
