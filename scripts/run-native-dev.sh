#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
source "$script_dir/native-dev-sources.zsh"
source "$script_dir/native-mock-processes.sh"
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
  print -u2 'Activate that app and press Command-Q; closing its panel can leave the app running.'
  exit 1
fi
needs_build=0
if [[ ! -x "$binary" || "$script_dir/build-native-dev.sh" -nt "$binary" ||
      "$script_dir/native-dev-sources.zsh" -nt "$binary" ||
      "$script_dir/development_signing.py" -nt "$binary" ||
      "$repository_root/.build/development-signing-identity" -nt "$binary" ]]; then
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
own_dev=$(native_mock_pids_for_binary "$binary") || {
  print -u2 'Could not verify whether this SystemOne Dev build is already running.'
  exit 1
}
# The launcher may enable a decision provider for this session only.
session_env=()
if [[ ${SYSTEMONE_DECISION_PROVIDER:-} == jev ]]; then
  session_env=(--env SYSTEMONE_DECISION_PROVIDER=jev)
fi
if [[ -n "$own_dev" ]]; then
  open "${session_env[@]}" "$app_dir"
else
  open -n "${session_env[@]}" "$app_dir"
fi
for (( attempt = 0; attempt < 30; attempt++ )); do
  own_dev=$(native_mock_pids_for_binary "$binary") || exit 1
  if [[ -n "$own_dev" ]]; then break; fi
  /bin/sleep 0.1
done
if [[ -z "$own_dev" ]]; then
  print -u2 'SystemOne Dev did not remain running after LaunchServices returned.'
  exit 1
fi
echo 'SystemOne Dev opens a menu-bar panel with a Dock fallback.'
