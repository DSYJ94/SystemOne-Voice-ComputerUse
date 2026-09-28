#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
scratch=$(mktemp -d /private/tmp/systemone-chrome-listener-check.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
host_source="$repository_root/.build/chrome-dev/SystemOneChromeNativeHost"
if [[ ! -x "$host_source" ]]; then
  print -u2 'Build the development Chrome bridge first.'
  exit 1
fi
cp "$host_source" "$scratch/SystemOneChromeNativeHost"
host="$scratch/SystemOneChromeNativeHost"
codesign --force --sign - --identifier com.aurium.systemone.chromenativehost "$host"
host_hash=$(codesign -dv --verbose=4 "$host" 2>&1 | sed -n 's/^CDHash=//p')

swiftc -swift-version 6 -parse-as-library -framework Security -lbsm \
  "$repository_root/packages/protocol/swift/Sources/PeerIdentity/PeerIdentity.swift" \
  "$repository_root/apps/native-dev/DevChromeListener.swift" \
  "$repository_root/apps/native-dev/DevChromeListenerCheck.swift" \
  -o "$scratch/DevChromeListenerCheck"
codesign --force --sign - --identifier com.aurium.systemone.devlistenercheck \
  "$scratch/DevChromeListenerCheck"
self_hash=$(codesign -dv --verbose=4 "$scratch/DevChromeListenerCheck" \
  2>&1 | sed -n 's/^CDHash=//p')
"$scratch/DevChromeListenerCheck" "$host" "$scratch" "$host_hash" "$self_hash"
