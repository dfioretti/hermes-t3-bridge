#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
T3_HOME="${T3CODE_HOME:-${HOME}/.t3}"
T3_BIN="${T3_CLI:-$(command -v t3 || true)}"

if [[ -z "${T3_BIN}" ]]; then
  printf '%s\n' 'hermes-t3-bridge: t3 CLI not found on PATH' >&2
  exit 127
fi

pairing_output="$(${T3_BIN} pair --base-dir "${T3_HOME}")"
pairing_url="$(PAIRING_OUTPUT="${pairing_output}" node -e '
const match = process.env.PAIRING_OUTPUT.match(/https?:\/\/\S+\/pair#token=\S+/);
if (!match) process.exit(1);
process.stdout.write(match[0]);
')"
unset pairing_output

if [[ -z "${pairing_url}" ]]; then
  printf '%s\n' 'hermes-t3-bridge: T3 did not return a pairing URL' >&2
  exit 1
fi

export T3_PAIRING_URL="${pairing_url}"
unset pairing_url
exec "${ROOT}/node_modules/.bin/tsx" "${ROOT}/src/server.ts"
