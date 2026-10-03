#!/bin/zsh
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ '^[a-p]{32}$' ]]; then
  print -u2 'Usage: scripts/build-chrome-dev-bridge.sh EXACT_EXTENSION_ID'
  exit 2
fi

script_dir=${0:A:h}
repository_root=${script_dir:h}
extension_id=$1
output_dir="$repository_root/.build/chrome-dev"
host="$output_dir/SystemOneChromeNativeHost"
manifest="$output_dir/com.aurium.systemone.chrome.json"
source "$script_dir/native-mock-processes.sh"
running_pids=$(native_mock_pids_for_binary "$host") || {
  print -u2 'Could not verify whether the development Chrome host is running.'
  exit 1
}
if [[ -n "$running_pids" ]]; then
  print -u2 'Quit the development Chrome host before replacing its signed binary.'
  exit 1
fi

mkdir -p "$output_dir"
export CLANG_MODULE_CACHE_PATH=/private/tmp/systemone-clang-cache
export SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/systemone-clang-cache
swift build --package-path "$repository_root/packages/chrome-native-host" \
  --cache-path /private/tmp/systemone-swift-cache \
  --product SystemOneChromeNativeHost
binary_dir=$(swift build --package-path "$repository_root/packages/chrome-native-host" \
  --cache-path /private/tmp/systemone-swift-cache --show-bin-path)
cp "$binary_dir/SystemOneChromeNativeHost" "$host"
codesign --force --sign - --identifier com.aurium.systemone.chromenativehost "$host"
codesign --verify --strict "$host"
host_hash=$(codesign -dv --verbose=4 "$host" 2>&1 | sed -n 's/^CDHash=//p')
if [[ ! "$host_hash" =~ '^[a-f0-9]{40,128}$' ]]; then
  print -u2 'Could not read the signed development Chrome host CDHash.'
  exit 1
fi

SYSTEMONE_DEV_CHROME_EXTENSION_ID="$extension_id" \
SYSTEMONE_DEV_CHROME_HOST_SIGNING_ID='com.aurium.systemone.chromenativehost' \
SYSTEMONE_DEV_CHROME_HOST_CDHASH="$host_hash" \
  zsh "$script_dir/build-native-dev.sh"

app="$repository_root/.build/native-dev/SystemOne Dev.app"
app_hash=$(codesign -dv --verbose=4 "$app" 2>&1 | sed -n 's/^CDHash=//p')
if [[ ! "$app_hash" =~ '^[a-f0-9]{40,128}$' ]]; then
  print -u2 'Could not read the signed development app CDHash.'
  exit 1
fi

/usr/bin/python3 - "$output_dir" "$host" "$manifest" "$extension_id" \
  "$app_hash" <<'PY'
import json
import os
import pathlib
import sys

output_dir, host, manifest, extension_id, app_hash = sys.argv[1:]
socket = os.path.join(os.path.expanduser('~'), 'Library',
                      'Application Support', 'SystemOne-Dev', 'controller.sock')
configuration = {
    'extensionId': extension_id,
    'controllerSigningIdentifier': 'com.aurium.systemone.dev',
    'controllerTeamIdentifier': None,
    'controllerCDHashes': [app_hash],
    'testControllerSocketPath': socket,
}
registration = {
    'name': 'com.aurium.systemone.chrome',
    'description': 'SystemOne development existing Chrome bridge',
    'path': host,
    'type': 'stdio',
    'allowed_origins': [f'chrome-extension://{extension_id}/'],
}
for path, data, mode in [
    (os.path.join(output_dir, 'ChromeNativeHost.json'), configuration, 0o600),
    (manifest, registration, 0o644),
]:
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as stream:
        os.fchmod(stream.fileno(), mode)
        json.dump(data, stream, indent=2)
        stream.write('\n')
    os.replace(temporary, path)
PY

print "Built opt-in development bridge and manifest: $manifest"
print 'No Chrome profile or native-host registration was changed.'
