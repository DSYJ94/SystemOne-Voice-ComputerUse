#!/bin/zsh
set -euo pipefail

# Demonstrate the identity mechanism without reading/changing TCC or creating
# a Keychain identity. These executables never access apps, audio or accounts.
check_dir=$(mktemp -d /private/tmp/systemone-adhoc-identity.XXXXXX)
trap 'rm -rf "$check_dir"' EXIT
for version in one two; do
  cat > "$check_dir/$version.c" <<EOF
#include <stdio.h>
int main(void) { puts("synthetic build $version"); return 0; }
EOF
  /usr/bin/cc "$check_dir/$version.c" -o "$check_dir/$version"
  /usr/bin/codesign --force --sign - --identifier com.aurium.systemone.identitycheck \
    "$check_dir/$version" >/dev/null 2>&1
done
requirement=$(/usr/bin/codesign -d -r- "$check_dir/one" 2>&1 \
  | /usr/bin/sed -n 's/^.*designated => //p')
if [[ "$requirement" != cdhash* ]]; then
  print -u2 'FAIL: expected a hash-based ad-hoc designated requirement'
  exit 1
fi
/usr/bin/codesign --verify --strict -R "=$requirement" "$check_dir/one"
if /usr/bin/codesign --verify --strict -R "=$requirement" "$check_dir/two" >/dev/null 2>&1; then
  print -u2 'FAIL: changed build unexpectedly satisfies the old hash-based identity'
  exit 1
fi
print 'PASS: same identifier, changed ad-hoc build, old designated requirement rejected'
print 'This verifies code identity only; no live Accessibility grant was tested.'
