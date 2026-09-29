#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
test_dir=$(mktemp -d /private/tmp/systemone-voice-callback.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/module-cache"

swiftc -swift-version 6 -parse-as-library -framework AVFoundation -framework Speech \
  -module-cache-path "$test_dir/module-cache" \
  "$repository_root/apps/native-dev/OnDeviceSpeech.swift" \
  "$repository_root/apps/native-dev/tests/VoicePermissionCallbackSmoke.swift" \
  -o "$test_dir/voice-permission-callback"
"$test_dir/voice-permission-callback"
