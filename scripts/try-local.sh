#!/bin/zsh
set -euo pipefail

# Interactive development session. No Chrome registration, model download,
# microphone capture, or Accessibility permission request happens here.
script_dir=${0:A:h}
repository_root=${script_dir:h}
fixture_app="$repository_root/.build/native-mock/SystemOne Fixture.app"
fixture_binary="$fixture_app/Contents/MacOS/SystemOneFixture"
mock_binary="$repository_root/.build/native-mock/SystemOne Mock.app/Contents/MacOS/SystemOneMock"

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  print -u2 'This local test needs an Apple Silicon Mac.'
  exit 1
fi
if [[ ! -d "$repository_root/node_modules/playwright" ]]; then
  print -u2 'Install the pinned npm dependencies first with npm ci.'
  exit 1
fi
if ! (cd "$repository_root" && node --input-type=module -e \
    'import { chromium } from "playwright"; import { accessSync } from "node:fs"; accessSync(chromium.executablePath());'); then
  print -u2 'The version-matched Playwright Chromium executable is missing.'
  print -u2 'Install it explicitly before retrying: npx playwright install chromium'
  exit 1
fi
other_fixture=$(/bin/ps -axo pid=,comm= | /usr/bin/awk -v wanted="$fixture_binary" '
  {
    pid = $1
    sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
    if ($0 ~ /\/SystemOneFixture$/ && $0 != wanted) print pid ":" $0
  }') || {
  print -u2 'Could not inspect running Fixture builds; refusing to open an ambiguous target.'
  exit 1
}
if [[ -n "$other_fixture" ]]; then
  print -u2 'Quit the earlier SystemOne Fixture before opening this checkout:'
  print -u2 "$other_fixture"
  exit 1
fi

needs_fixture_build=0
if [[ ! -x "$fixture_binary" || ! -x "$mock_binary" ||
      "$repository_root/apps/native-fixture/main.swift" -nt "$fixture_binary" ||
      "$repository_root/apps/native-mock/main.swift" -nt "$mock_binary" ||
      "$repository_root/apps/native-mock/FixtureAX.swift" -nt "$mock_binary" ||
      "$script_dir/build-native-mock.sh" -nt "$fixture_binary" ]]; then
  needs_fixture_build=1
fi
if (( needs_fixture_build )); then
  zsh "$script_dir/build-native-mock.sh"
fi

print 'Opening SystemOne Dev and the synthetic Fixture. No task starts automatically.'
zsh "$script_dir/run-native-dev.sh"
open "$fixture_app"

print ''
print 'The loopback portal URL appears below. Leave this terminal open while testing.'
print 'Native: in SystemOne Dev use bundle ID com.aurium.systemone.fixture,'
print '        exact label Fixture Name, and a disposable value; click Fill native field.'
print 'Managed Chromium: use the URL below, label Find invoice, and a disposable'
print '        value; click Fill field. Stop closes the managed browser.'
print 'Existing Chrome: this command does not install or attach to your profile.'
print 'See docs/TRY_LOCAL.md for results and current limits. Ctrl-C stops the portal.'
print ''
exec node "$script_dir/run-portal-fixture.ts"
