# SPDX-License-Identifier: Apache-2.0
"""Offline Qwen3/CLM tensor adapter. No downloads, fallback, hot reload or HTTP.

Recipe source: Contrastive-LM/CLM bb42c6c5bf914fd449bed2f6ca65be80602cb1f7,
heads.py, embedder.py, engine.py and schema.py (Apache-2.0).
Full-weight/vLLM numerical qualification remains a separate experiment.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

MAX_FRAME = 262144
MAX_TOKENS = 2048


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("invalid fields")
    return value


def pairs(request):
    exact(request, ("state", "model", "questions", "temperature"))
    exact(request["questions"], ("next_action",))
    q = exact(request["questions"]["next_action"], ("type", "instructions", "criteria"))
    criteria = q["criteria"]
    if (request["model"] != "clm-latest" or q["type"] != "choice"
            or not isinstance(request["state"], str) or not isinstance(q["instructions"], str)
            or not isinstance(criteria, dict) or not 2 <= len(criteria) <= 128
            or any(not isinstance(k, str) or not k or not isinstance(v, str) or not v for k, v in criteria.items())
            or type(request["temperature"]) not in (float, int)
            or not 0 < request["temperature"] <= 100):
        raise ValueError("invalid choice")
    state, instruction = request["state"].strip(), q["instructions"].strip()
    combined = f"{state}\n\n{instruction}" if state and instruction else state or instruction
    return list(criteria), [combined, *criteria.values()]


def token_ids(tokenizer, texts):
    if (not isinstance(texts, list) or not 1 <= len(texts) <= 129
            or any(not isinstance(t, str) for t in texts)
            or sum(len(t.encode("utf-8")) for t in texts) > 65536):
        raise ValueError("invalid text batch")
    # Explicit special-token behavior, no chat template, truncation or padding.
    ids = [tokenizer.encode(t, add_special_tokens=True, truncation=False) for t in texts]
    if any(not row for row in ids):
        raise ValueError("empty token sequence")
    return ids


def make_head(cfg, projection_dim):
    import torch.nn as nn
    width, depth = cfg["width"], cfg["depth"]
    if (type(width) is not int or not 1 <= width <= 16384
            or type(depth) is not int or not 2 <= depth <= 16
            or type(projection_dim) is not int or not 1 <= projection_dim <= 4096
            or cfg.get("hidden_size", 4096) != 4096
            or cfg.get("activation", "gelu") not in ("gelu", "relu", "silu")
            or type(cfg.get("layernorm", False)) is not bool
            or type(cfg.get("residual", False)) is not bool):
        raise ValueError("invalid head architecture")
    activation = {"gelu": nn.GELU, "relu": nn.ReLU, "silu": nn.SiLU}[cfg.get("activation", "gelu")]

    class Head(nn.Module):
        def __init__(self):
            super().__init__()
            self.inp = nn.Linear(4096, width)
            self.hidden = nn.ModuleList(nn.Linear(width, width) for _ in range(depth - 2))
            self.norms = nn.ModuleList(nn.LayerNorm(width) if cfg.get("layernorm", False) else nn.Identity()
                                       for _ in range(depth - 2))
            self.out = nn.Linear(width, projection_dim)
            self.act = activation()

        def forward(self, x):
            x = self.act(self.inp(x))
            for linear, norm in zip(self.hidden, self.norms):
                hidden = self.act(norm(linear(x)))
                x = x + hidden if cfg.get("residual", False) else hidden
            return self.out(x)

    return Head()


def load_heads(path, device):
    import torch
    # No upstream implicit pickle loading, file watching, or download helper.
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    cfg = dict(checkpoint["cfg"])
    projection = checkpoint.get("projection_dim", cfg.get("projection_dim", 512))
    state, action = make_head(cfg, projection), make_head(cfg, projection)
    state.load_state_dict(checkpoint["state_head"], strict=True)
    action.load_state_dict(checkpoint["action_head"], strict=True)
    for head in (state, action):
        if any(not torch.isfinite(p).all() for p in head.parameters()):
            raise ValueError("nonfinite head")
        head.eval().to(device=device, dtype=torch.float32)
        head.requires_grad_(False)
    scale_tensor = torch.as_tensor(checkpoint["logit_scale"]).float()
    if scale_tensor.numel() != 1 or not torch.isfinite(scale_tensor).all():
        raise ValueError("invalid scale")
    scale = float(scale_tensor.exp().clamp(max=100.0))
    return state, action, scale


def rank_embeddings(embeddings, state_head, action_head, scale, temperature):
    import numpy as np
    import torch
    if (embeddings.ndim != 2 or embeddings.shape[0] < 3 or embeddings.shape[1] != 4096
            or not torch.isfinite(embeddings).all() or not math.isfinite(scale)
            or not 0 <= scale <= 100 or not 0 < temperature <= 100):
        raise ValueError("invalid ranking inputs")
    # Preserve the reference's NumPy float32 reduction, then transfer to the
    # heads. A GPU Torch norm changes rounding enough to perturb close scores.
    array = embeddings.detach().float().cpu().numpy()
    array = array / (np.linalg.norm(array, axis=-1, keepdims=True) + 1e-12)
    values = torch.from_numpy(array).to(embeddings.device)
    with torch.inference_mode():
        state = torch.nn.functional.normalize(state_head(values[:1]), dim=-1)
        actions = torch.nn.functional.normalize(action_head(values[1:]), dim=-1)
        # Reference scales in float32, then Python softmax on .tolist().
        logits = (scale * (actions @ state[0]) / temperature).tolist()
    if any(not math.isfinite(x) for x in logits):
        raise ValueError("nonfinite logits")
    exp = [math.exp(x - max(logits)) for x in logits]
    return [x / sum(exp) for x in exp]


def encode_last_token(model, row, device):
    import torch
    tokens = torch.tensor([row], device=device, dtype=torch.long)
    with torch.inference_mode():
        hidden = model(input_ids=tokens, attention_mask=torch.ones_like(tokens),
                       use_cache=False, return_dict=True).last_hidden_state
    return hidden[0, -1].float()


def verify_inventory(root, manifest):
    """Recheck local bytes in the worker before any tensor deserialization.

    The production deployment must mount artifacts read-only. Reject undeclared
    files so Transformers cannot discover alternate weights or tokenizer config.
    """
    root = Path(root).resolve(strict=True)
    declared = manifest["encoder"]["files"] + manifest["heads"]["files"]
    paths = {f["path"] for f in declared}
    fingerprints = {}
    for component in ("encoder", "heads"):
        for path in (root / component).rglob("*"):
            if path.is_symlink() or (path.is_file() and path.relative_to(root).as_posix() not in paths):
                raise ValueError("undeclared artifact")
    for file in declared:
        path = root / file["path"]
        if any(p.is_symlink() for p in [path, *path.parents]) or not path.is_file():
            raise ValueError("invalid artifact path")
        before = path.stat()
        if before.st_size != file["bytes"]:
            raise ValueError("artifact size mismatch")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        after = path.stat()
        if before != after or digest.hexdigest() != file["sha256"]:
            raise ValueError("artifact changed or hash mismatch")
        fingerprints[path] = after
    return root, fingerprints


class ReferenceBackend:
    def __init__(self, root, manifest, device):
        # The supervisor validated the full manifest before spawning this worker.
        self.root, self.fingerprints = verify_inventory(root, manifest)
        import importlib.metadata
        import platform
        import re
        if device == "mps":
            lock = Path(__file__).with_name("requirements-macos.lock").read_bytes()
            runtime = manifest["runtime"]
            if (platform.system() != "Darwin" or platform.machine() != "arm64"
                    or platform.python_version() != runtime["pythonVersion"]
                    or hashlib.sha256(lock).hexdigest() != runtime["requirementsSha256"]):
                raise ValueError("native runtime pin mismatch")
            for name, version in re.findall(r"^([\w.-]+)==([^\s]+)", lock.decode(), re.MULTILINE):
                if importlib.metadata.version(name) != version:
                    raise ValueError("native dependency pin mismatch")
        elif (importlib.metadata.version("torch").split("+")[0] != "2.8.0"
              or importlib.metadata.version("transformers") != "4.57.6"):
            raise ValueError("tensor runtime pin mismatch")
        import torch
        from transformers import AutoConfig, AutoModel, AutoTokenizer
        if (device == "cuda" and (not torch.cuda.is_available() or not torch.cuda.is_bf16_supported())):
            raise ValueError("CUDA bfloat16 unavailable")
        if device == "mps" and not torch.backends.mps.is_available():
            raise ValueError("Metal unavailable")
        if device not in ("cuda", "mps"):
            raise ValueError("explicit GPU device required")
        self.device = device
        if device == "mps":
            # Keep headroom for macOS/speech; never disable the allocator limit.
            torch.mps.set_per_process_memory_fraction(0.70)
            torch.zeros(1, dtype=torch.bfloat16, device="mps")  # fail before model load if unsupported
        encoder = self.root / "encoder"
        cfg = AutoConfig.from_pretrained(encoder, local_files_only=True, trust_remote_code=False)
        if cfg.model_type != "qwen3" or cfg.hidden_size != 4096 or getattr(cfg, "auto_map", None):
            raise ValueError("incompatible encoder")
        self.tokenizer = AutoTokenizer.from_pretrained(encoder, local_files_only=True,
                                                       trust_remote_code=False, use_fast=True)
        self.model = AutoModel.from_pretrained(encoder, config=cfg, local_files_only=True,
                                               trust_remote_code=False, use_safetensors=True,
                                               torch_dtype=torch.bfloat16, attn_implementation="eager",
                                               **({"device_map": {"": "mps"}, "low_cpu_mem_usage": True}
                                                  if device == "mps" else {}))
        # Metal loading goes directly to the GPU to avoid two 16GB copies in
        # unified memory. No CPU/disk offload or automatic device-map fallback.
        self.model.eval()
        if device != "mps": self.model.to(device)
        self.model.requires_grad_(False)
        self.state_head, self.action_head, self.scale = load_heads(self.root / "heads/CLM_v0.1-8B.pt", device)
        self.unchanged()

    def unchanged(self):
        for path, stat in self.fingerprints.items():
            if path.is_symlink() or path.stat() != stat:
                raise ValueError("artifact changed; restart refused")

    def count(self, texts):
        self.unchanged()
        return [len(row) for row in token_ids(self.tokenizer, texts)]

    def answer(self, request):
        import torch
        started = time.perf_counter()
        self.unchanged()
        keys, texts = pairs(request)
        ids = token_ids(self.tokenizer, texts)
        # Defense in depth: direct worker use cannot bypass ingress counting.
        if any(len(row) > MAX_TOKENS for row in ids):
            raise ValueError("token overflow")
        vectors, spent = {}, 0
        with torch.inference_mode():
            for text, row in zip(texts, ids):
                if text in vectors:
                    continue
                # No padding: the last token is exactly the last non-pad token.
                vectors[text] = encode_last_token(self.model, row, self.device)
                spent += len(row)
            probabilities = rank_embeddings(torch.stack([vectors[t] for t in texts]),
                                              self.state_head, self.action_head, self.scale,
                                              request["temperature"])
        self.unchanged()
        choice = keys[max(range(len(keys)), key=probabilities.__getitem__)]
        if self.device == "mps":
            torch.mps.synchronize()
            allocated = torch.mps.current_allocated_memory()
            driver = torch.mps.driver_allocated_memory()
        else:
            torch.cuda.synchronize()
            allocated = torch.cuda.memory_allocated()
            driver = None
        return {"model": "clm-latest", "answers": {"next_action": {"type": "choice", "choice": choice,
                "probabilities": dict(zip(keys, probabilities))}}, "usage": {"input_tokens": spent},
                # Local benchmark only. HTTP ingress never forwards these fields.
                "metrics": {"latencyMs": (time.perf_counter() - started) * 1000,
                            "gpuAllocatedBytes": allocated, "gpuDriverAllocatedBytes": driver}}


def unique_object(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def read_message():
    line = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not line:
        return None
    if len(line) > MAX_FRAME or not line.endswith(b"\n"):
        raise ValueError("invalid frame")
    return json.loads(line, object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")))


def write_message(value):
    encoded = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode() + b"\n"
    if len(encoded) > MAX_FRAME:
        raise ValueError("invalid reply size")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    # Set before third-party imports; local_files_only is also required per load.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      TOKENIZERS_PARALLELISM="false")
    init = exact(read_message(), ("manifest", "artifactRoot", "device", "manifestDigest"))
    backend = ReferenceBackend(init["artifactRoot"], init["manifest"], init["device"])
    write_message({"ready": True, "manifestDigest": init["manifestDigest"],
                   "tokenizerRevision": init["manifest"]["encoder"]["revision"]})
    while (message := read_message()) is not None:
        try:
            exact(message, ("id", "operation", "value"))
            if message["operation"] == "count":
                result = backend.count(message["value"])
            elif message["operation"] == "answer":
                result = backend.answer(message["value"])
            else:
                raise ValueError("invalid operation")
            write_message({"id": message["id"], "ok": True, "value": result})
        except Exception:
            # No request text, model tracebacks, tokens or artifact paths on wire.
            write_message({"id": message.get("id"), "ok": False})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
