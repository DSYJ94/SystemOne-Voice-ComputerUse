#!/usr/bin/env python3
"""Fail a development bundle that cannot present the two voice consent prompts."""

import pathlib
import plistlib
import sys


def check_bundle(app: pathlib.Path) -> None:
    plist = app / "Contents" / "Info.plist"
    with plist.open("rb") as source:
        info = plistlib.load(source)
    if info.get("CFBundleIdentifier") != "com.aurium.systemone.dev":
        raise ValueError("unexpected voice app bundle identifier")
    if info.get("CFBundleExecutable") != "SystemOneDev":
        raise ValueError("unexpected voice app executable")
    if not (app / "Contents" / "MacOS" / "SystemOneDev").is_file():
        raise ValueError("voice app executable is absent")
    for key in ("NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"):
        value = info.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} is absent or empty")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: check-voice-bundle-metadata.py APP_PATH")
    try:
        check_bundle(pathlib.Path(sys.argv[1]))
    except (OSError, plistlib.InvalidFileException, ValueError) as error:
        raise SystemExit(f"voice bundle metadata check failed: {error}") from error
    print("Voice bundle metadata present (live TCC permission flow unverified).")
