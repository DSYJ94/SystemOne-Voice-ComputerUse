#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
"$script_dir/build-native-mock.sh"
open "$repository_root/.build/native-mock/SystemOne Mock.app"
echo 'Look for S1 Mock in the macOS menu bar; choose Open Command Panel.'
