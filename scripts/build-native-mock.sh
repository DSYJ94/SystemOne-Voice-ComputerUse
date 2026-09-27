#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
app_dir="$repository_root/.build/native-mock/SystemOne Mock.app"
contents="$app_dir/Contents"
mkdir -p "$contents/MacOS"
mkdir -p "$repository_root/.build/native-mock/module-cache"

fixture_dir="$repository_root/.build/native-mock/SystemOne Fixture.app"
fixture_contents="$fixture_dir/Contents"
mkdir -p "$fixture_contents/MacOS"

source "$script_dir/native-mock-processes.sh"
mock_pids=$(native_mock_pids_for_binary "$contents/MacOS/SystemOneMock")
fixture_pids=$(native_mock_pids_for_binary "$fixture_contents/MacOS/SystemOneFixture")
if [[ -n "$mock_pids" || -n "$fixture_pids" ]]; then
  print -u2 'Quit the running SystemOne Mock and SystemOne Fixture test apps before rebuilding.'
  print -u2 'Use npm run run:native-mock for a clean restart of these synthetic apps.'
  exit 1
fi

swiftc -swift-version 6 -parse-as-library -framework AppKit \
  -module-cache-path "$repository_root/.build/native-mock/module-cache" \
  "$repository_root/apps/native-fixture/main.swift" \
  -o "$fixture_contents/MacOS/SystemOneFixture"

cat > "$fixture_contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>SystemOneFixture</string>
  <key>CFBundleIdentifier</key><string>com.aurium.systemone.fixture</string>
  <key>CFBundleName</key><string>SystemOne Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

swiftc -swift-version 6 -parse-as-library -framework AppKit \
  -framework ApplicationServices \
  -module-cache-path "$repository_root/.build/native-mock/module-cache" \
  "$repository_root/apps/native-mock/main.swift" \
  "$repository_root/apps/native-mock/FixtureAX.swift" \
  -o "$contents/MacOS/SystemOneMock"

cat > "$contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>SystemOneMock</string>
  <key>CFBundleIdentifier</key><string>com.aurium.systemone.native-mock</string>
  <key>CFBundleName</key><string>SystemOne Mock</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# Cloud-synced checkouts can attach Finder/file-provider metadata to generated
# bundles. codesign rejects those extended attributes as resource detritus.
# These are disposable local test outputs, so clear only their xattrs before
# applying the ad-hoc development signatures.
/usr/bin/xattr -cr "$app_dir" "$fixture_dir"
codesign --force --deep --sign - "$app_dir"
codesign --force --deep --sign - "$fixture_dir"
echo "Built $app_dir and $fixture_dir"
