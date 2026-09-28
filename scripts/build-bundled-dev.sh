#!/bin/zsh
set -euo pipefail

# This is a movable, ad-hoc-signed development bundle. Release signing,
# notarization, Chrome host registration and clean-Mac acceptance remain B27.
if [[ $# -ne 2 ]]; then
  print -u2 'Usage: scripts/build-bundled-dev.sh VERIFIED_NODE_ARCHIVE PLAYWRIGHT_BROWSER_CACHE_ROOT'
  exit 2
fi

script_dir=${0:A:h}
repository_root=${script_dir:h}
archive=${1:A}
browser_root=${2:A}
expected_hash=48231d6204eca6be13e6c5184dfdffa1d64ad88880364cc2cfb198f872cb2b13
if [[ ! -f "$archive" ]]; then
  print -u2 'Pinned official Node archive is missing.'
  exit 1
fi
actual_hash=$(shasum -a 256 "$archive" | awk '{print $1}')
if [[ "$actual_hash" != "$expected_hash" ]]; then
  print -u2 'Node archive checksum mismatch; no bundle was changed.'
  exit 1
fi

revision=$(cd "$repository_root" && node -p \
  "require('./node_modules/playwright-core/browsers.json').browsers.find(x => x.name === 'chromium').revision")
if [[ ! "$revision" =~ '^[0-9]{3,6}$' ]]; then
  print -u2 'Could not resolve the pinned Playwright Chromium revision.'
  exit 1
fi
browser="$browser_root/chromium-$revision"
headless="$browser_root/chromium_headless_shell-$revision"
if [[ ! -f "$browser/INSTALLATION_COMPLETE" || ! -d "$browser/chrome-mac-arm64"
   || ! -f "$headless/INSTALLATION_COMPLETE" ]]; then
  print -u2 "Version-matched Playwright Chromium is missing: $browser"
  exit 1
fi

app="$repository_root/.build/bundled-dev/SystemOne Dev.app"
source "$script_dir/native-mock-processes.sh"
running_pids=$(native_mock_pids_for_binary "$app/Contents/MacOS/SystemOneDev") || {
  print -u2 'Could not verify whether the bundled development app is running.'
  exit 1
}
if [[ -n "$running_pids" ]]; then
  print -u2 'Quit the bundled development app before replacing it.'
  exit 1
fi

zsh "$script_dir/build-native-dev.sh"
source_app="$repository_root/.build/native-dev/SystemOne Dev.app"
output_root="$repository_root/.build/bundled-dev"
mkdir -p "$output_root"
if [[ -e "$app" ]]; then
  rm -rf -- "$app"
fi
/usr/bin/ditto "$source_app" "$app"
contents="$app/Contents"
runtime="$contents/Resources/runtime"
mkdir -p "$contents/Frameworks" "$runtime/packages/runtime" \
  "$runtime/packages/protocol" "$runtime/packages/browser" \
  "$contents/Resources/licenses" "$contents/Resources/browsers"

tar -xJOf "$archive" node-v26.5.0-darwin-arm64/bin/node \
  > "$contents/Frameworks/node"
chmod 755 "$contents/Frameworks/node"
tar -xJOf "$archive" node-v26.5.0-darwin-arm64/LICENSE \
  > "$contents/Resources/licenses/node-LICENSE"
if [[ $("$contents/Frameworks/node" -p 'process.version + ":" + process.arch') \
    != 'v26.5.0:arm64' ]]; then
  print -u2 'Bundled Node executable is not the pinned Apple Silicon runtime.'
  exit 1
fi
if otool -L "$contents/Frameworks/node" | grep -E '/opt/|/usr/local/|@rpath' >/dev/null; then
  print -u2 'Bundled Node has an external non-system runtime dependency.'
  exit 1
fi

/usr/bin/ditto "$repository_root/packages/runtime/src" "$runtime/packages/runtime/src"
/usr/bin/ditto "$repository_root/packages/protocol/src" "$runtime/packages/protocol/src"
/usr/bin/ditto "$repository_root/packages/browser/src" "$runtime/packages/browser/src"
cp "$repository_root/packages/protocol/protocol.schema.json" "$runtime/packages/protocol/"
cp "$repository_root/package.json" "$repository_root/package-lock.json" "$runtime/"
(cd "$runtime" && npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund)

/usr/bin/ditto "$browser" "$contents/Resources/browsers/chromium-$revision"
/usr/bin/ditto "$headless" \
  "$contents/Resources/browsers/chromium_headless_shell-$revision"
/usr/libexec/PlistBuddy -c 'Delete :SystemOneNodeExecutable' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :SystemOneControllerScript' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :SystemOneBundledRuntime bool true' "$contents/Info.plist"
/usr/bin/xattr -cr "$app"
codesign --force --sign - --identifier com.aurium.systemone.bundlednode \
  "$contents/Frameworks/node"
node_cdhash=$(codesign -dv --verbose=4 "$contents/Frameworks/node" 2>&1 \
  | sed -n 's/^CDHash=//p')
if [[ ! "$node_cdhash" =~ '^[a-f0-9]{40,128}$' ]]; then
  print -u2 'Could not pin the signed bundled Node code hash.'
  exit 1
fi
/usr/libexec/PlistBuddy -c \
  "Add :SystemOneControllerNodeCDHash string $node_cdhash" "$contents/Info.plist"
codesign --force --sign - --identifier com.aurium.systemone.dev "$app"
codesign --verify --deep --strict "$app"

print "Built movable ad-hoc development app: $app"
print 'No Chrome native host is bundled or registered; this is not a notarized release.'
