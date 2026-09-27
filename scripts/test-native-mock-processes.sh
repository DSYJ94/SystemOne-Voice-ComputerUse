#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
source "$script_dir/native-mock-processes.sh"
test_dir=$(/usr/bin/mktemp -d /private/tmp/systemone-process-test.XXXXXX)
test_binary="$test_dir/SystemOne Fixture"
other_binary="$test_dir/Unrelated Fixture"
/bin/cp /bin/sleep "$test_binary"
/bin/cp /bin/sleep "$other_binary"
"$test_binary" 30 &
test_pid=$!
"$other_binary" 30 &
other_pid=$!
cleanup() {
  /bin/kill -TERM "$test_pid" "$other_pid" 2>/dev/null || true
  wait "$test_pid" "$other_pid" 2>/dev/null || true
  /bin/rm -rf "$test_dir"
}
trap cleanup EXIT

found=$(native_mock_pids_for_binary "$test_binary")
[[ "$found" == "$test_pid" ]] || {
  print -u2 'Exact synthetic executable was not found.'
  exit 1
}
native_mock_stop_binary "$test_binary"
wait "$test_pid" 2>/dev/null || true
[[ -z "$(native_mock_pids_for_binary "$test_binary")" ]] || {
  print -u2 'Synthetic executable was still running after stop.'
  exit 1
}
/bin/kill -0 "$other_pid" || {
  print -u2 'An unrelated executable was stopped.'
  exit 1
}
print 'Exact-path process detection and clean stop passed.'
