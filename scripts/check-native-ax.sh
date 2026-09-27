#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
build_dir="$(mktemp -d /private/tmp/systemone-native-ax.XXXXXX)"
trap 'rm -rf "$build_dir"' EXIT

export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export CLANG_MODULE_CACHE_PATH="$build_dir/clang-cache"
mkdir -p "$CLANG_MODULE_CACHE_PATH"

swiftc -swift-version 6 -emit-library -emit-module -module-name NativeAX \
  "$repo_root"/packages/native-ax/Sources/NativeAX/*.swift \
  -emit-module-path "$build_dir/NativeAX.swiftmodule" \
  -o "$build_dir/libNativeAX.dylib"
swiftc -swift-version 6 -I "$build_dir" -L "$build_dir" -lNativeAX \
  "$repo_root/packages/native-ax/Sources/NativeAXCheck/main.swift" \
  -o "$build_dir/NativeAXCheck"
DYLD_LIBRARY_PATH="$build_dir" "$build_dir/NativeAXCheck"
