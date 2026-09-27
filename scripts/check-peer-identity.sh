#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
package_path="$repository_root/packages/protocol/swift"
scratch=$(mktemp -d /private/tmp/systemone-peer-check.XXXXXX)
trap 'rm -rf "$scratch"' EXIT

export CLANG_MODULE_CACHE_PATH=/private/tmp/systemone-clang-cache
export SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/systemone-clang-cache

swift build --package-path "$package_path" \
  --cache-path /private/tmp/systemone-swift-cache \
  --product PeerIdentityCheck

binary_path=$(swift build --package-path "$package_path" \
  --cache-path /private/tmp/systemone-swift-cache \
  --show-bin-path)/PeerIdentityCheck

expected="$scratch/expected-peer"
wrong_identifier="$scratch/wrong-identifier-peer"
wrong_hash="$scratch/wrong-hash-peer"
cp "$binary_path" "$expected"
cp "$binary_path" "$wrong_identifier"
cp "$binary_path" "$wrong_hash"

codesign --force --sign - --identifier com.aurium.systemone.peercheck "$expected"
codesign --force --sign - --identifier com.aurium.systemone.impostor "$wrong_identifier"

codesign --remove-signature "$wrong_hash"
install_name_tool -add_rpath @executable_path/variant "$wrong_hash"
codesign --force --sign - --identifier com.aurium.systemone.peercheck "$wrong_hash"

"$expected"
"$expected" --child "$wrong_identifier" --expect-reject
"$expected" --child "$wrong_hash" --expect-reject
