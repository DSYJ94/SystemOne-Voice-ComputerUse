"""Pin an available local signing certificate, never a private key or password.

No certificate creation, import, Keychain trust change, or TCC reset occurs here.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


FINGERPRINT = re.compile(r"[A-Fa-f0-9]{40}\Z")


def parse_identities(output):
    return [(fingerprint.upper(), name) for fingerprint, name in re.findall(
        r'^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\n]+)"\s*$', output, re.MULTILINE)]


def resolve_identity(explicit, pinned, identities):
    requested = explicit if explicit is not None else pinned
    if requested is None or requested == "-":
        return "-"
    matches = [fingerprint for fingerprint, name in identities
               if requested.upper() == fingerprint or requested == name]
    if len(matches) != 1:
        raise ValueError("Configured signing identity is unavailable or ambiguous; refusing ad-hoc fallback.")
    return matches[0]


def choose_certificate(requested, identities):
    candidates = [(fingerprint, name) for fingerprint, name in identities
                  if name.startswith(("Apple Development:", "Developer ID Application:"))]
    if requested is not None:
        if not FINGERPRINT.fullmatch(requested):
            raise ValueError("Use the certificate's 40-character fingerprint, not a name or private key.")
        return resolve_identity(requested, None, candidates)
    if len(candidates) == 1:
        return candidates[0][0]
    if not candidates:
        raise ValueError("No Apple development signing certificate is available. Install Xcode, sign in "
                         "under Settings > Apple Accounts, then Manage Certificates > + > Apple Development. "
                         "A regular Apple ID can use a Personal Team for local development. "
                         "See docs/DEVELOPMENT_SIGNING.md.")
    raise ValueError("Multiple certificates are available. Run security find-identity -v -p codesigning, "
                     "then configure with --identity <certificate fingerprint>.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["resolve", "configure"])
    parser.add_argument("--identity")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    pin = root / ".build" / "development-signing-identity"
    identities = parse_identities(subprocess.run(
        ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"],
        check=True, text=True, capture_output=True).stdout)
    if args.operation == "resolve":
        pinned = pin.read_text().strip() if pin.exists() else None
        if pinned is not None and not FINGERPRINT.fullmatch(pinned):
            raise ValueError("Invalid local certificate pin; refusing to sign.")
        print(resolve_identity(os.environ.get("SYSTEMONE_CODESIGN_IDENTITY"), pinned, identities))
    else:
        if "SYSTEMONE_CODESIGN_IDENTITY" in os.environ:
            raise ValueError("Unset SYSTEMONE_CODESIGN_IDENTITY before configuring a persistent local certificate pin.")
        selected = choose_certificate(args.identity, identities)
        pin.parent.mkdir(parents=True, exist_ok=True)
        temporary = pin.with_suffix(".tmp")
        temporary.write_text(selected + "\n")
        temporary.replace(pin)
        print("Local certificate pinned. Future native development builds will use it; "
              "no private key was exported. Quit SystemOne before rebuilding.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
