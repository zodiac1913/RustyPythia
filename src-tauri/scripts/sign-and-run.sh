#!/usr/bin/env bash
# Signs the dev binary with a stable local identity before launching it.
# Without this the linker's ad-hoc signature changes on every rebuild, so macOS
# treats each build as a different app and re-prompts for Keychain access.
set -euo pipefail

BINARY="$1"
shift

IDENTITY="${RUSTY_PYTHIA_SIGN_IDENTITY:-RustyPythia Dev}"

if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  codesign --force --sign "$IDENTITY" \
    --identifier com.rxjr.rustypythia \
    --preserve-metadata=entitlements \
    "$BINARY" >/dev/null 2>&1 ||
    echo "warning: failed to sign $BINARY with '$IDENTITY'; Keychain will re-prompt" >&2
else
  echo "warning: code signing identity '$IDENTITY' not found; Keychain will re-prompt" >&2
fi

exec "$BINARY" "$@"
