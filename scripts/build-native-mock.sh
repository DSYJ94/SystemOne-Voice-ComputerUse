#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
app_dir="$repository_root/.build/native-mock/SystemOne Mock.app"
contents="$app_dir/Contents"
mkdir -p "$contents/MacOS"
mkdir -p "$repository_root/.build/native-mock/module-cache"

swiftc -swift-version 6 -parse-as-library -framework AppKit \
  -module-cache-path "$repository_root/.build/native-mock/module-cache" \
  "$repository_root/apps/native-mock/main.swift" \
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

codesign --force --deep --sign - "$app_dir"
echo "Built $app_dir"
