#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
app_dir="$repository_root/.build/native-mock/SystemOne Mock.app"
binary="$app_dir/Contents/MacOS/SystemOneMock"
fixture_binary="$repository_root/.build/native-mock/SystemOne Fixture.app/Contents/MacOS/SystemOneFixture"
source "$script_dir/native-mock-processes.sh"
# A prior build may still be resident even if its bundle was replaced on disk.
# Reopening that process crashed the fixture on this Mac. Start both test apps
# fresh; never overwrite a running bundle or rely on LaunchServices reuse.
native_mock_stop_binary "$binary"
native_mock_stop_binary "$fixture_binary"
if [[ ! -x "$binary" || ! -x "$fixture_binary" ||
      "$repository_root/apps/native-mock/main.swift" -nt "$binary" ||
      "$repository_root/apps/native-mock/FixtureAX.swift" -nt "$binary" ||
      "$repository_root/apps/native-fixture/main.swift" -nt "$fixture_binary" ||
      "$script_dir/build-native-mock.sh" -nt "$binary" ]]; then
  "$script_dir/build-native-mock.sh"
fi
open "$app_dir"
echo 'SystemOne Mock opens its command panel and has a Dock fallback if its menu-bar item is hidden.'
