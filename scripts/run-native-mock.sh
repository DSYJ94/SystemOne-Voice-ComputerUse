#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
app_dir="$repository_root/.build/native-mock/SystemOne Mock.app"
binary="$app_dir/Contents/MacOS/SystemOneMock"
if [[ ! -x "$binary" || "$repository_root/apps/native-mock/main.swift" -nt "$binary" ||
      "$script_dir/build-native-mock.sh" -nt "$binary" ]]; then
  "$script_dir/build-native-mock.sh"
fi
open "$app_dir"
echo 'SystemOne Mock opens its command panel and has a Dock fallback if its menu-bar item is hidden.'
