#!/bin/zsh
set -euo pipefail
script_dir=${0:A:h}
repository_root=${script_dir:h}
zsh "$script_dir/build-native-dev.sh"
"$repository_root/.build/native-dev/SystemOne Dev.app/Contents/MacOS/SystemOneDev" \
  --check-accessibility-recovery
