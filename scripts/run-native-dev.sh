#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
source "$script_dir/native-dev-sources.zsh"
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
needs_build=0
if [[ ! -x "$binary" || "$script_dir/build-native-dev.sh" -nt "$binary" ||
      "$script_dir/native-dev-sources.zsh" -nt "$binary" ]]; then
  needs_build=1
else
  for source_file in "${native_dev_sources[@]}"; do
    if [[ ! -f "$source_file" || "$source_file" -nt "$binary" ]]; then
      needs_build=1
      break
    fi
  done
fi
if (( needs_build )); then
  if [[ -f "$app_dir/Contents/Info.plist" ]] &&
     /usr/libexec/PlistBuddy -c 'Print :SystemOneChromeExtensionId' \
       "$app_dir/Contents/Info.plist" >/dev/null 2>&1; then
    print -u2 'The Chrome-configured development app is stale. Rebuild it with scripts/build-chrome-dev-bridge.sh and its exact extension ID.'
    exit 1
  fi
  "$script_dir/build-native-dev.sh"
fi
open "$app_dir"
echo 'SystemOne Dev opens a menu-bar panel with a Dock fallback.'
