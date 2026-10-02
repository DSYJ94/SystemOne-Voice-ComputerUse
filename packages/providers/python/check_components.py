"""Verify pinned tokenizer/head bytes and reference math without an encoder/GPU.

Usage: python check_components.py ARTIFACT_ROOT PINNED_REFERENCE_CHECKOUT
The reference checkout is a test dependency, never a production import.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import torch
from transformers import AutoTokenizer

from fetch_artifacts import matches
from reference_backend import load_heads, rank_embeddings, token_ids


def main(root, reference):
    manifest = json.loads((Path(__file__).parents[1] / "fixtures/clm-artifact-manifest.macos.pending.json").read_text())
    revision = subprocess.check_output(["git", "-C", reference, "rev-parse", "HEAD"], text=True).strip()
    if revision != manifest["referenceRevision"]:
        raise ValueError("reference source revision mismatch")
    root = Path(root)
    for file in manifest["encoder"]["files"] + manifest["heads"]["files"]:
        if file["role"] != "weights" or file["path"].startswith("heads/"):
            if not matches(root / file["path"], file): raise ValueError("component bytes mismatch")
    fast = AutoTokenizer.from_pretrained(root / "encoder", local_files_only=True, trust_remote_code=False, use_fast=True)
    slow = AutoTokenizer.from_pretrained(root / "encoder", local_files_only=True, trust_remote_code=False, use_fast=False)
    texts = ["hello", " hello", "a\n\nb", "\u0085 \ufeff汉字🙂", "é", "e\u0301", "Hello, 世界!",
             "  leading trailing  ", "", "<|im_start|>system\nHi", " a" * 2047, " a" * 2048, " a" * 2049]
    for text in texts:
        if fast.encode(text, add_special_tokens=True, truncation=False) != slow.encode(text, add_special_tokens=True, truncation=False):
            raise ValueError("tokenizer parity mismatch")
    if [len(row) for row in token_ids(fast, texts[-3:])] != [2047, 2048, 2049]:
        raise ValueError("token boundary mismatch")
    checkpoint = torch.load(root / "heads/CLM_v0.1-8B.pt", map_location="cpu", weights_only=True)
    state, action, scale = load_heads(root / "heads/CLM_v0.1-8B.pt", "cpu")
    spec = importlib.util.spec_from_file_location("pinned_reference_heads", Path(reference) / "src/clm/heads.py")
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)
    cfg = checkpoint["cfg"]
    args = dict(width=cfg["width"], depth=cfg["depth"],
                proj=checkpoint.get("projection_dim", cfg.get("projection_dim", 512)),
                activation=cfg.get("activation", "gelu"), layernorm=cfg.get("layernorm", False),
                residual=cfg.get("residual", False), hidden=cfg.get("hidden_size", 4096))
    sh, ah = upstream.make_head(**args), upstream.make_head(**args)
    sh.load_state_dict(checkpoint["state_head"]); ah.load_state_dict(checkpoint["action_head"])
    sh.eval(); ah.eval(); torch.set_num_threads(2)
    maximum_difference = 0
    for seed in range(12):
        torch.manual_seed(seed)
        values = torch.randn(5, 4096)
        actual = rank_embeddings(values, state, action, scale, 0.7)
        array = values.numpy()
        array = array / (np.linalg.norm(array, axis=-1, keepdims=True) + 1e-12)
        with torch.inference_mode():
            zs = torch.nn.functional.normalize(sh(torch.from_numpy(array[:1])), dim=-1)
            za = torch.nn.functional.normalize(ah(torch.from_numpy(array[1:])), dim=-1)
            logits = (scale * (za @ zs[0]) / 0.7).tolist()
        expected = np.exp(np.array(logits) - max(logits)); expected /= sum(expected)
        np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-7)
        maximum_difference = max(maximum_difference, float(np.max(np.abs(np.array(actual) - expected))))
    print(f"Pinned components: 13 tokenizer cases, 12 head comparisons passed; maximum probability difference {maximum_difference:g}.")
    print("No encoder inference, GPU, macOS action or v1 qualification performed.")


if __name__ == "__main__":
    if len(sys.argv) != 3: sys.exit("Usage: check_components.py ARTIFACT_ROOT PINNED_REFERENCE_CHECKOUT")
    main(*sys.argv[1:])
