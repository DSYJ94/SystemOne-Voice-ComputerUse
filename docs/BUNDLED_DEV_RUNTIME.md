# Bundled development runtime

Updated 28 September 2026. This is a B27 packaging spike, **not** a release
artifact. It keeps the development app independent of Homebrew Node and the
builder's Playwright cache at runtime. It does not bundle or register the
existing-Chrome native host, ship CLM/ASR, or prove a clean-Mac installation.

The build accepts the official Node `v26.5.0` Apple Silicon `.tar.xz` and a
version-matched Playwright browser cache root. It verifies the archive against
the pinned SHA-256 from Node's
[official `SHASUMS256.txt`](https://nodejs.org/dist/v26.5.0/SHASUMS256.txt)
before changing the output:

```
48231d6204eca6be13e6c5184dfdffa1d64ad88880364cc2cfb198f872cb2b13
```

For the current Mac's ignored build cache:

```sh
zsh scripts/build-bundled-dev.sh \
  .build/release-deps/node-v26.5.0-darwin-arm64.tar.xz \
  "$HOME/Library/Caches/ms-playwright"
node scripts/check-bundled-dev.mjs \
  '/absolute/path/to/.build/bundled-dev/SystemOne Dev.app'
```

The script copies only the Node executable and license from the checked
archive. It copies the runtime source modules and schema, installs production
npm packages from the committed lockfile with scripts disabled, and copies the
Playwright 1.63.0 Chromium and headless-shell revision `1243`. It rewrites the
app metadata to use paths inside its own bundle, then ad-hoc signs the bundled
Node and outer app. The signed app metadata pins the bundled Node signing
identifier and code hash. On launch, the AppKit parent checks the exact running
child process through Apple's
[dynamic code-signing lookup](https://developer.apple.com/documentation/security/seccodecopyguestwithattributes%28_%3A_%3A_%3A_%3A%29)
before accepting controller output and checks it again before
sending commands or handling worker replies. The smoke checker verifies this
headlessly through the actual AppKit executable, then verifies the bundle
signature, rejects
external controller paths in `Info.plist`, starts the bundled controller with
a restricted `PATH`, and makes the bundled Chromium observe the loopback
invoice portal. It does not launch the AppKit UI or touch a user Chrome profile.

An isolated copy with only its expected Node code hash changed was re-signed
ad hoc and the headless AppKit startup rejected the mismatch. The standalone
external-source development build remains unauthenticated by design and is
never a release configuration. This PID/code-signature check relies on the
native parent retaining the exact launched `Process`; a PID alone is not a
durable peer identity. Release must add Developer ID identity, an authenticated
supervisor/worker channel, durable worker-side permit checks and update-safe
identity rotation.

The local output is about 715 MB without model weights. The official Node
binary linked only system libraries in the local `otool -L` check; the
Homebrew Node candidate linked multiple `/opt/homebrew` libraries and is not
suitable as a copied release runtime. The bundled app also passed the smoke
check after being moved to another directory in the same worktree.

Release work remains: sign every nested executable with an appropriate
Developer ID/hardened-runtime policy, package and register the Chrome native
host without mutable trust pins, notarize and staple the distribution, publish
complete license notices and an SBOM, verify updates/rollback, and install on
a clean supported Mac without developer tools. The official Node archive hash
was compared with an HTTPS checksum manifest; a signed release process must
also authenticate that manifest and record its provenance. A passing ad-hoc
signature or local relocation check is not a substitute for those gates.
