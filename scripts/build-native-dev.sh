#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
app_dir="$repository_root/.build/native-dev/SystemOne Dev.app"
contents="$app_dir/Contents"
binary="$contents/MacOS/SystemOneDev"
source "$script_dir/native-mock-processes.sh"
running_pids=$(native_mock_pids_for_binary "$binary") || {
  print -u2 'Could not verify whether SystemOne Dev is running; refusing to replace its signed executable.'
  exit 1
}
if [[ -n "$running_pids" ]]; then
  print -u2 'Quit SystemOne Dev before rebuilding its signed executable.'
  exit 1
fi

node_path=$(node -p 'process.execPath')
controller_path="$repository_root/packages/runtime/src/native-managed-controller.ts"
if [[ ! -x "$node_path" || ! -f "$controller_path" ]]; then
  print -u2 'Pinned local Node runtime or controller source is missing.'
  exit 1
fi

mkdir -p "$contents/MacOS" "$repository_root/.build/native-dev/module-cache"
swiftc -swift-version 6 -parse-as-library -framework AppKit -framework Carbon \
  -framework Security -lbsm -lsqlite3 \
  -module-cache-path "$repository_root/.build/native-dev/module-cache" \
  "$repository_root/apps/native-dev/main.swift" \
  "$repository_root/apps/native-dev/DevChromeListener.swift" \
  "$repository_root/apps/native-dev/NativeFieldWorker.swift" \
  "$repository_root/apps/native-dev/NativeInspectionSession.swift" \
  "$repository_root/apps/native-dev/NativeWorkerPermitLedger.swift" \
  "$repository_root/apps/native-dev/NativeHostPermit.swift" \
  "$repository_root/apps/native-dev/NativeWorkerPermitDigest.swift" \
  "$repository_root/packages/protocol/swift/Sources/PeerIdentity/PeerIdentity.swift" \
  "$repository_root/packages/protocol/swift/Sources/ProtocolDigest/CanonicalJSON.swift" \
  "$repository_root/packages/native-ax/Sources/NativeAX/Observation.swift" \
  "$repository_root/packages/native-ax/Sources/NativeAX/SystemAXBackend.swift" \
  "$repository_root/packages/native-ax/Sources/NativeAX/ValueAction.swift" \
  "$repository_root/packages/native-ax/Sources/NativeAX/PressAction.swift" \
  -o "$binary"

/usr/bin/python3 - "$contents/Info.plist" "$node_path" "$controller_path" <<'PY'
import os
import plistlib
import re
import sys

path, node, controller = sys.argv[1:]
extension_id = os.getenv('SYSTEMONE_DEV_CHROME_EXTENSION_ID')
host_id = os.getenv('SYSTEMONE_DEV_CHROME_HOST_SIGNING_ID')
host_cdhash = os.getenv('SYSTEMONE_DEV_CHROME_HOST_CDHASH')
host_team = os.getenv('SYSTEMONE_DEV_CHROME_HOST_TEAM_ID')
chrome_values = [extension_id, host_id, host_cdhash, host_team]
if any(chrome_values):
    if not extension_id or not re.fullmatch(r'[a-p]{32}', extension_id):
        raise SystemExit('invalid development Chrome extension ID')
    if not host_id or not re.fullmatch(r'[A-Za-z0-9.-]{1,200}', host_id):
        raise SystemExit('invalid development Chrome host signing identifier')
    if host_cdhash and not re.fullmatch(r'[a-f0-9]{40,128}', host_cdhash):
        raise SystemExit('invalid development Chrome host CDHash')
    if host_team and not re.fullmatch(r'[A-Z0-9]{10}', host_team):
        raise SystemExit('invalid development Chrome host Team ID')
    if not host_cdhash and not host_team:
        raise SystemExit('development Chrome host needs a Team ID or CDHash')
metadata = {
    'CFBundleExecutable': 'SystemOneDev',
    'CFBundleIdentifier': 'com.aurium.systemone.dev',
    'CFBundleName': 'SystemOne Dev',
    'CFBundlePackageType': 'APPL',
    'CFBundleVersion': '1',
    'CFBundleShortVersionString': '0.1.0',
    'NSHighResolutionCapable': True,
    'SystemOneNodeExecutable': node,
    'SystemOneControllerScript': controller,
}
if any(chrome_values):
    metadata['SystemOneChromeExtensionId'] = extension_id
    metadata['SystemOneChromeHostSigningIdentifier'] = host_id
    metadata['SystemOneChromeHostCDHashes'] = [host_cdhash] if host_cdhash else []
    if host_team:
        metadata['SystemOneChromeHostTeamIdentifier'] = host_team
with open(path, 'wb') as output:
    plistlib.dump(metadata, output)
PY

# Disposable local output can inherit Finder/file-provider xattrs from the
# cloud-synced checkout; clear them before signing this development bundle.
/usr/bin/xattr -cr "$app_dir"
signing_identity=${SYSTEMONE_CODESIGN_IDENTITY:--}
codesign --force --sign "$signing_identity" --identifier com.aurium.systemone.dev "$app_dir"
codesign --verify --deep --strict "$app_dir"
if [[ "$signing_identity" == '-' ]]; then
  print -u2 'Development app uses ad-hoc signing and an external Node path; this is not a distributable build.'
fi
echo "Built $app_dir"
