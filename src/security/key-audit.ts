/**
 * Key material audit — grep-based detection of leaked key patterns in log output.
 *
 * This utility scans arbitrary text (log lines, config dumps, etc.) for patterns
 * that look like provider API keys. Used in tests to verify zero key leakage.
 */

/** Patterns that match common provider key formats. */
const KEY_PATTERNS: { provider: string; pattern: RegExp }[] = [
  { provider: "anthropic", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { provider: "openai", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { provider: "google", pattern: /AIza[A-Za-z0-9_-]{30,}/ },
  { provider: "discord", pattern: /[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/ },
];

export interface KeyLeakMatch {
  provider: string;
  line: number;
  match: string;
}

/**
 * Scan text content for key-like patterns.
 * Returns an array of matches found — empty array means no leaks detected.
 */
export function scanForKeyLeaks(content: string): KeyLeakMatch[] {
  const leaks: KeyLeakMatch[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { provider, pattern } of KEY_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        leaks.push({
          provider,
          line: i + 1,
          match: `${match[0].slice(0, 8)}...${match[0].slice(-4)}`,
        });
      }
    }
  }

  return leaks;
}
