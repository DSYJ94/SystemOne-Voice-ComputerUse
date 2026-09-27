#!/bin/zsh

# Used only by the two synthetic development bundles. Compare the executable's
# complete path, not its display name or bundle ID, before signaling a process.
function native_mock_pids_for_binary() {
  local binary="$1"
  /bin/ps -axo pid=,comm= | /usr/bin/awk -v wanted="$binary" '
    {
      pid = $1
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
      if ($0 == wanted) print pid
    }'
}

function native_mock_stop_binary() {
  local binary="$1"
  local pids pid remaining
  pids=$(native_mock_pids_for_binary "$binary") || return 1
  if [[ -z "$pids" ]]; then return 0; fi
  for pid in ${(f)pids}; do
    print "Stopping synthetic test app pid=$pid before rebuild/reopen: $binary"
    /bin/kill -TERM "$pid" 2>/dev/null || true
  done
  for (( remaining = 0; remaining < 50; remaining++ )); do
    pids=$(native_mock_pids_for_binary "$binary") || return 1
    if [[ -z "$pids" ]]; then return 0; fi
    /bin/sleep 0.1
  done
  print -u2 "Synthetic test app did not stop; refusing to replace or reopen it: $binary"
  return 1
}
