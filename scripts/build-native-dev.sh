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
swiftc -swift-version 6 -parse-as-library -framework AppKit \
  -module-cache-path "$repository_root/.build/native-dev/module-cache" \
  "$repository_root/apps/native-dev/main.swift" -o "$binary"

/usr/bin/python3 - "$contents/Info.plist" "$node_path" "$controller_path" <<'PY'
import plistlib
import sys

path, node, controller = sys.argv[1:]
with open(path, 'wb') as output:
    plistlib.dump({
        'CFBundleExecutable': 'SystemOneDev',
        'CFBundleIdentifier': 'com.aurium.systemone.dev',
        'CFBundleName': 'SystemOne Dev',
        'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1',
        'CFBundleShortVersionString': '0.1.0',
        'NSHighResolutionCapable': True,
        'SystemOneNodeExecutable': node,
        'SystemOneControllerScript': controller,
    }, output)
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
