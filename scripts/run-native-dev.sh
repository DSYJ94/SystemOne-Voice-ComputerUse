#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
app_dir="$repository_root/.build/native-dev/SystemOne Dev.app"
binary="$app_dir/Contents/MacOS/SystemOneDev"
if [[ ! -x "$binary" ||
      "$repository_root/apps/native-dev/main.swift" -nt "$binary" ||
      "$repository_root/packages/native-ax/Sources/NativeAX/Observation.swift" -nt "$binary" ||
      "$repository_root/packages/native-ax/Sources/NativeAX/SystemAXBackend.swift" -nt "$binary" ||
      "$repository_root/packages/native-ax/Sources/NativeAX/ValueAction.swift" -nt "$binary" ||
      "$script_dir/build-native-dev.sh" -nt "$binary" ]]; then
  "$script_dir/build-native-dev.sh"
fi
open "$app_dir"
echo 'SystemOne Dev opens a menu-bar panel with a Dock fallback.'
