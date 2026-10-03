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

print '2/4  Building the Fixture test app if needed…'
fixture_app="$repository_root/.build/native-mock/SystemOne Fixture.app"
fixture_binary="$fixture_app/Contents/MacOS/SystemOneFixture"
source "$script_dir/native-mock-processes.sh"
if [[ ! -x "$fixture_binary" || "$repository_root/apps/native-fixture/main.swift" -nt "$fixture_binary" ||
      "$script_dir/build-native-mock.sh" -nt "$fixture_binary" ]]; then
  zsh "$script_dir/build-native-mock.sh" >/dev/null
fi
# A resident old Fixture can crash on reuse; always start it fresh.
native_mock_stop_binary "$fixture_binary"
open -n "$fixture_app"

print '3/4  Restarting SystemOne Dev with Jev for this session…'
dev_binary="$repository_root/.build/native-dev/SystemOne Dev.app/Contents/MacOS/SystemOneDev"
if [[ -n "$(native_mock_pids_for_binary "$dev_binary")" ]]; then
  /usr/bin/osascript -e 'tell application id "com.aurium.systemone.dev" to quit' >/dev/null 2>&1 || true
  for (( attempt = 0; attempt < 50; attempt++ )); do
    [[ -z "$(native_mock_pids_for_binary "$dev_binary")" ]] && break
    /bin/sleep 0.1
  done
fi
SYSTEMONE_DECISION_PROVIDER=jev zsh "$script_dir/run-native-dev.sh" >/dev/null

print '4/4  Ready.'
print '     Press Control-Option-Space for the SystemOne bar, type  open Budget.xlsx  and press Return.'
print '     Jev chooses each step in SystemOne Fixture; Control-Option-Escape stops.'
print '     After a rebuild, use ⋯ → Accessibility… if the bar says this build is not authorized.'
