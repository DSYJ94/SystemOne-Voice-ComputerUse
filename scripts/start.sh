#!/bin/zsh
# One command for owner testing: check Jev, build what is stale, open the
# synthetic Fixture, and start SystemOne Dev with Jev enabled for this session.
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
cd "$repository_root"

print '1/4  Checking Node and the Jev key…'
node_version=$(node -p 'process.versions.node')
[[ $node_version == 26.* ]] || { print -u2 "Node 26.x required (found $node_version)."; exit 1; }
node scripts/check-jev.ts

print '2/4  Closing leftover test windows…'
source "$script_dir/native-mock-processes.sh"
for leftover in "$repository_root/.build/native-mock/SystemOne Fixture.app/Contents/MacOS/SystemOneFixture" \
                "$repository_root/.build/native-mock/SystemOne Mock.app/Contents/MacOS/SystemOneMock"; do
  native_mock_stop_binary "$leftover" || true
done

print '3/4  Restarting SystemOne Dev with Jev for this session…'
dev_binary="$repository_root/.build/native-dev/SystemOne Dev.app/Contents/MacOS/SystemOneDev"
if [[ -n "$(native_mock_pids_for_binary "$dev_binary")" ]]; then
  /usr/bin/osascript -e 'tell application id "com.aurium.systemone.dev" to quit' >/dev/null 2>&1 &
  for (( attempt = 0; attempt < 80; attempt++ )); do
    [[ -z "$(native_mock_pids_for_binary "$dev_binary")" ]] && break
    /bin/sleep 0.1
  done
  # An older build could hang in Quit; end only this checkout's own dev app.
  for pid in ${(f)"$(native_mock_pids_for_binary "$dev_binary")"}; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  /bin/sleep 0.5
fi
SYSTEMONE_DECISION_PROVIDER=jev zsh "$script_dir/run-native-dev.sh" >/dev/null

print '4/4  Ready.'
print '     Hold Control-Option-Space (change it in Settings), speak, and let go. Or type, e.g.'
print '       go to wikipedia and search for Alan Turing'
print '     Esc or Control-Option-Escape stops at any time.'
print '     First run after setup: add .build/native-dev/SystemOne Dev.app under'
print '     System Settings → Privacy & Security → Accessibility (once; signing keeps it).'
