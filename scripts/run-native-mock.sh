#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
"$script_dir/build-native-mock.sh"
open "$repository_root/.build/native-mock/SystemOne Mock.app"
echo 'SystemOne Mock opens its command panel and has a Dock fallback if its menu-bar item is hidden.'
