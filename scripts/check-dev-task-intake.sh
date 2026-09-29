#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
check_dir=$(mktemp -d /private/tmp/systemone-task-intake.XXXXXX)
trap 'rm -rf "$check_dir"' EXIT
mkdir -p "$check_dir/module-cache"
swiftc -swift-version 6 -parse-as-library \
  -module-cache-path "$check_dir/module-cache" \
  "$repository_root/apps/native-dev/DevTaskIntake.swift" \
  "$repository_root/apps/native-dev/tests/DevTaskIntakeCheck.swift" \
  -o "$check_dir/DevTaskIntakeCheck"
"$check_dir/DevTaskIntakeCheck"
