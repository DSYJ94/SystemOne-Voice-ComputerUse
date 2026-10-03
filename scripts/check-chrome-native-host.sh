#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
package_path="$repository_root/packages/chrome-native-host"
scratch=$(mktemp -d /private/tmp/systemone-chrome-host-check.XXXXXX)
trap 'rm -rf "$scratch"' EXIT

export CLANG_MODULE_CACHE_PATH=/private/tmp/systemone-clang-cache
export SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/systemone-clang-cache

swift build --package-path "$package_path" \
  --cache-path /private/tmp/systemone-swift-cache \
  --product SystemOneChromeNativeHost
swift build --package-path "$package_path" \
  --cache-path /private/tmp/systemone-swift-cache \
  --product ChromeNativeHostCheck

binary_dir=$(swift build --package-path "$package_path" \
  --cache-path /private/tmp/systemone-swift-cache --show-bin-path)
cp "$binary_dir/SystemOneChromeNativeHost" "$scratch/SystemOneChromeNativeHost"
cp "$binary_dir/ChromeNativeHostCheck" "$scratch/ChromeNativeHostCheck"
codesign --force --sign - --identifier com.aurium.systemone.chromenativehost "$scratch/SystemOneChromeNativeHost"
codesign --force --sign - --identifier com.aurium.systemone.chromehostcheck "$scratch/ChromeNativeHostCheck"
"$scratch/ChromeNativeHostCheck" "$scratch/SystemOneChromeNativeHost" "$scratch"
