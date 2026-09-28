#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
app_dir="$repository_root/.build/native-dev/SystemOne Dev.app"
binary="$app_dir/Contents/MacOS/SystemOneDev"
other_dev=$(/bin/ps -axo pid=,comm= | /usr/bin/awk -v wanted="$binary" '
  {
    pid = $1
    sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
    if ($0 ~ /\/SystemOneDev$/ && $0 != wanted) print pid ":" $0
  }') || {
  print -u2 'Could not inspect running SystemOne Dev builds; refusing to open another.'
  exit 1
}
if [[ -n "$other_dev" ]]; then
  print -u2 'Quit the earlier SystemOne Dev build before opening this checkout:'
  print -u2 "$other_dev"
  exit 1
fi
if [[ ! -x "$binary" ||
      "$repository_root/apps/native-dev/main.swift" -nt "$binary" ||
      "$repository_root/apps/native-dev/NativeFieldWorker.swift" -nt "$binary" ||
      "$repository_root/packages/native-ax/Sources/NativeAX/Observation.swift" -nt "$binary" ||
      "$repository_root/packages/native-ax/Sources/NativeAX/SystemAXBackend.swift" -nt "$binary" ||
      "$repository_root/packages/native-ax/Sources/NativeAX/ValueAction.swift" -nt "$binary" ||
      "$script_dir/build-native-dev.sh" -nt "$binary" ]]; then
  "$script_dir/build-native-dev.sh"
fi
open "$app_dir"
echo 'SystemOne Dev opens a menu-bar panel with a Dock fallback.'
