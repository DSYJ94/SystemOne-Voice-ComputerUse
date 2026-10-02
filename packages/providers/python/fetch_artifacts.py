"""Fetch only the committed immutable artifact plan, with size/hash verification.

Uses standard HTTPS/proxy/CA configuration. Never prints signed redirect URLs.
Does not load tensors, deploy infrastructure, or modify existing mismatched bytes.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.request


def matches(path, file):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != file["bytes"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024): digest.update(chunk)
    return digest.hexdigest() == file["sha256"]


def fetch_file(url, path, file, open_url=urllib.request.urlopen):
    if path.exists() or path.is_symlink():
        if not matches(path, file): raise ValueError("existing artifact differs; preserve and investigate")
        return
    fd, temporary = tempfile.mkstemp(prefix="artifact-", suffix=".part", dir=path.parent)
    try:
        digest, size = hashlib.sha256(), 0
        with os.fdopen(fd, "wb") as output, open_url(url, timeout=60) as response:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > file["bytes"]: raise ValueError("artifact exceeded declared size")
                digest.update(chunk); output.write(chunk)
        if size != file["bytes"] or digest.hexdigest() != file["sha256"]:
            raise ValueError("artifact integrity mismatch")
        # Link atomically without clobbering a concurrently created user file.
        try:
            os.link(temporary, path)
        except FileExistsError:
            if not matches(path, file): raise ValueError("concurrent artifact differs; preserve and investigate")
    finally:
        os.unlink(temporary)


def fetch_plan(root):
    plan = Path(__file__).parents[1] / "fixtures/clm-artifact-manifest.macos.pending.json"
    manifest = json.loads(plan.read_text())
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    for component, repository in (("encoder", "Qwen/Qwen3-8B"), ("heads", "Contrastive-LM/CLM-v0.1-8B")):
        entry = manifest[component]
        if entry["repository"] != repository or not re.fullmatch(r"[a-f0-9]{40}", entry["revision"]):
            raise ValueError("invalid immutable repository")
        for file in entry["files"]:
            relative = file["path"]
            if (not re.fullmatch(component + r"/[A-Za-z0-9][A-Za-z0-9._-]*", relative)
                    or not re.fullmatch(r"[a-f0-9]{64}", file["sha256"])
                    or type(file["bytes"]) is not int or not 0 < file["bytes"] <= 100_000_000_000):
                raise ValueError("invalid artifact declaration")
            folder = root / component
            if folder.is_symlink(): raise ValueError("artifact directory symlink")
            folder.mkdir(exist_ok=True)
            name = relative.split("/")[1]
            fetch_file(f"https://huggingface.co/{repository}/resolve/{entry['revision']}/{name}",
                       root / relative, file)
            print("Verified " + relative, flush=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2: raise ValueError("artifact root argument required")
        fetch_plan(sys.argv[1])
    except Exception:
        print("Artifact fetch failed; check destination policy, storage and declared integrity. Existing files preserved.",
              file=sys.stderr)
        sys.exit(1)
