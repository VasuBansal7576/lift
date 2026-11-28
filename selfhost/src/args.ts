export type FlagMap = Record<string, string | boolean>;

export function parseArgs(argv: string[]): { flags: FlagMap; rest: string[] } {
  const flags: FlagMap = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const trimmed = token.slice(2);
    const eq = trimmed.indexOf("=");
    if (eq >= 0) {
      flags[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      flags[trimmed] = next;
      i += 1;
    } else {
      flags[trimmed] = true;
    }
  }
  return { flags, rest };
}

export function flagString(flags: FlagMap, name: string, fallback = ""): string {
  const value = flags[name];
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

export function flagBool(flags: FlagMap, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}
