#!/bin/bash
# scripts/check-hardcoded-secrets.sh
#
# CI gate: scan for hardcoded secrets in source code.
# Exits non-zero if any potential secrets are found.

set -euo pipefail

SCAN_DIRS="src/ scripts/ templates/"
EXIT_CODE=0

# Patterns that indicate hardcoded secrets (not type annotations or variable names)
# Each pattern is: regex|description
PATTERNS=(
  'sk_live_[a-zA-Z0-9]+|Stripe live secret key'
  'sk_test_[a-zA-Z0-9]+|Stripe test secret key'
  'sk-ant-[a-zA-Z0-9]+|Anthropic API key'
  'sk-[a-zA-Z0-9]{20,}|OpenAI-style API key'
  'ghp_[a-zA-Z0-9]{36}|GitHub personal access token'
  'gho_[a-zA-Z0-9]{36}|GitHub OAuth token'
  'AKIA[0-9A-Z]{16}|AWS access key ID'
  "password\\s*[:=]\\s*[\"'][^\"']{8,}[\"']|Hardcoded password"
  "secret\\s*[:=]\\s*[\"'][^\"']{8,}[\"']|Hardcoded secret"
)

# Files/patterns to exclude (test fixtures, type definitions, etc.)
EXCLUDE_ARGS=(
  --glob '!**/*.test.ts'
  --glob '!**/node_modules/**'
  --glob '!**/dist/**'
  --glob '!**/*.d.ts'
)

for entry in "${PATTERNS[@]}"; do
  pattern="${entry%%|*}"
  description="${entry##*|}"

  # Use ripgrep if available, otherwise grep
  if command -v rg &>/dev/null; then
    matches=$(rg --no-heading -n "$pattern" "${EXCLUDE_ARGS[@]}" $SCAN_DIRS 2>/dev/null || true)
  else
    matches=$(grep -rn -E "$pattern" $SCAN_DIRS --include='*.ts' --include='*.sh' --include='*.json' --exclude-dir=node_modules --exclude-dir=dist --exclude='*.test.ts' --exclude='*.d.ts' 2>/dev/null || true)
  fi

  if [ -n "$matches" ]; then
    echo "WARNING: Potential $description found:"
    echo "$matches"
    echo ""
    EXIT_CODE=1
  fi
done

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "OK: No hardcoded secrets detected."
else
  echo ""
  echo "FAIL: Potential hardcoded secrets found. See above."
  echo "If these are false positives, add them to the exclude list in scripts/check-hardcoded-secrets.sh"
fi

exit $EXIT_CODE
