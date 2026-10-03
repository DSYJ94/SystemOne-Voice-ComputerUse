#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
check_dir=$(mktemp -d /private/tmp/systemone-task-command.XXXXXX)
trap 'rm -rf "$check_dir"' EXIT
swiftc -swift-version 6 \
  "$repository_root/apps/native-dev/ScopedTaskCommand.swift" \
  "$repository_root/apps/native-dev/ScopedTaskCommandCheck.swift" \
  -o "$check_dir/ScopedTaskCommandCheck"
"$check_dir/ScopedTaskCommandCheck"
