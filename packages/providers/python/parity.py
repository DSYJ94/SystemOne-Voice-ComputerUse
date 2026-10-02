# SPDX-License-Identifier: Apache-2.0
"""Full-encoder parity between the owned MPS worker path and the pinned reference.

    parity.py capture-mps MANIFEST ARTIFACT_ROOT OUTPUT CORPUS...
    parity.py capture-reference REFERENCE_CHECKOUT ARTIFACT_ROOT ENDPOINT OUTPUT CORPUS...
    parity.py compare REFERENCE_REPORT MPS_REPORT OUTPUT [--heads HEADS]

capture-mps runs on the owner Mac through ReferenceBackend itself (same pins,
inventory, encoder and head code as the serving worker). capture-reference runs
on a Linux/CUDA host against a vLLM pooling server started with the pinned
recipe (serve_qwen3_8b.sh at referenceRevision) and calls the pinned upstream
Engine/Embedder, not this repository's reimplementation. compare applies the
pre-registered candidate tolerances. Reports hold synthetic fixture text and
raw vectors only, are created once with mode 0600 and never carry authority.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

from reference_backend import pairs, rank_embeddings, token_ids

FIXTURES = Path(__file__).parents[1] / "fixtures"
REPORT_KIND = "clm-parity-capture"


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def request_of(view, temperature=1):
    # Byte-for-byte the wire shape of encodeCLMProviderView.
    return {"state": view["stateText"], "model": "clm-latest", "questions": {"next_action": {
        "type": "choice", "instructions": view["questionText"],
        "criteria": {c["candidateId"]: c["description"] for c in view["candidates"]}}},
        "temperature": temperature}


def load_corpora(paths):
    corpora, cases, seen = [], [], set()
    for path in paths:
        raw = Path(path).read_bytes()
        fixtures = json.loads(raw)
        if not isinstance(fixtures, list) or not fixtures:
            raise ValueError("corpus must be a non-empty fixture list")
        name = Path(path).name
        corpora.append({"name": name, "sha256": sha(raw), "cases": len(fixtures)})
        for fixture in fixtures:
            if fixture.get("synthetic") is not True or fixture["id"] in seen:
                raise ValueError("parity corpora hold unique synthetic fixtures only")
            seen.add(fixture["id"])
            cases.append((name, fixture["id"], request_of(fixture["providerView"])))
    return corpora, cases


def vector(array):
    import numpy as np
    return base64.b64encode(np.ascontiguousarray(array, dtype="<f4").tobytes()).decode()


def unvector(text):
    import numpy as np
    return np.frombuffer(base64.b64decode(text), dtype="<f4")


def l2(array):
    import numpy as np
    # Reference embedder.l2: float32, epsilon outside the norm.
    return array / (np.linalg.norm(array, axis=-1, keepdims=True) + 1e-12)


def exclusive_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=1)
        handle.write("\n")


def projected_cosines(embeddings, state_head, action_head, device):
    import torch
    values = torch.from_numpy(l2(embeddings)).to(device)
    with torch.inference_mode():
        state = torch.nn.functional.normalize(state_head(values[:1]), dim=-1)
        actions = torch.nn.functional.normalize(action_head(values[1:]), dim=-1)
        return (actions @ state[0]).tolist()


def capture_mps(backend, corpora, cases):
    """Per text: exact token count and pooled vector; per case: distributions."""
    import numpy as np
    import torch
    texts, results = {}, []
    for corpus, case_id, request in cases:
        keys, case_texts = pairs(request)
        rows = token_ids(backend.tokenizer, case_texts)
        embeddings = []
        for text, row in zip(case_texts, rows):
            digest = sha(text)
            if digest not in texts:
                hidden = backend.encode(row)
                texts[digest] = {"tokens": len(row), "rawNorm": float(np.linalg.norm(hidden)),
                                 "embedding": vector(l2(hidden))}
                texts[digest]["_raw"] = hidden
            embeddings.append(texts[digest]["_raw"])
        stacked = np.stack(embeddings)
        started = time.perf_counter()
        first = backend.answer(request)
        latency = (time.perf_counter() - started) * 1000
        second = backend.answer(request)
        probabilities = [first["answers"]["next_action"]["probabilities"][k] for k in keys]
        repeat = [second["answers"]["next_action"]["probabilities"][k] for k in keys]
        # The captured vectors must be exactly the ones the serving path ranked.
        recomputed = rank_embeddings(torch.from_numpy(stacked).to(backend.device), backend.state_head,
                                     backend.action_head, backend.scale, request["temperature"])
        results.append({"corpus": corpus, "caseId": case_id, "keys": keys,
                        "textSha256": [sha(t) for t in case_texts], "probabilities": probabilities,
                        "repeatProbabilities": repeat, "capturedVectorsReproduce": recomputed == probabilities,
                        "projectedCosines": projected_cosines(stacked, backend.state_head, backend.action_head,
                                                              backend.device),
                        "latencyMs": latency})
    for record in texts.values():
        del record["_raw"]
    return {"texts": texts, "cases": results, "scale": backend.scale}


def capture_reference(engine, embed, tokenize, cases, build_pairs):
    """engine/embed are the pinned upstream objects; tokenize asks the vLLM server."""
    texts, results = {}, []
    for corpus, case_id, request in cases:
        upstream = build_pairs(request["state"], request["questions"])["next_action"]
        keys, case_texts = upstream[1], [upstream[0], *upstream[2]]
        vectors, _ = embed(case_texts)
        for text, value in zip(case_texts, vectors):
            texts.setdefault(sha(text), {"tokens": tokenize(text), "embedding": vector(value)})
        answers = []
        for _ in range(2):
            embed.clear()  # repetition must re-encode, not reuse the upstream LRU
            out = engine.answer(request["state"], request["questions"], request["model"], request["temperature"])
            answers.append([out["answers"]["next_action"]["probabilities"][k] for k in keys])
        results.append({"corpus": corpus, "caseId": case_id, "keys": keys,
                        "textSha256": [sha(t) for t in case_texts], "probabilities": answers[0],
                        "repeatProbabilities": answers[1]})
    return {"texts": texts, "cases": results}


def git(*args, cwd=None):
    return subprocess.check_output(["git", *args], text=True, cwd=cwd).strip()


def identity(manifest):
    head = next(f for f in manifest["heads"]["files"] if f["path"].endswith(".pt"))
    return {"referenceRevision": manifest["referenceRevision"], "encoderRevision": manifest["encoder"]["revision"],
            "headsSha256": head["sha256"]}


def bound_manifest(path):
    """The local manifest may differ from the tracked plan only in its run bindings."""
    manifest = json.loads(Path(path).read_text())
    pending = json.loads((FIXTURES / "clm-artifact-manifest.macos.pending.json").read_text())
    runtime = dict(manifest["runtime"])
    if git("status", "--porcelain") or runtime.pop("serverRevision") != git("rev-parse", "HEAD"):
        raise ValueError("materialize the manifest at the current clean commit")
    if runtime.pop("pythonVersion") != platform.python_version():
        raise ValueError("manifest binds a different interpreter")
    expected = dict(pending["runtime"])
    expected.pop("serverRevision"); expected.pop("pythonVersion")
    if runtime != expected or {k: v for k, v in manifest.items() if k != "runtime"} != \
            {k: v for k, v in pending.items() if k != "runtime"}:
        raise ValueError("manifest differs from the tracked artifact plan")
    return manifest


def main_capture_mps(manifest_path, root, output, *corpus_paths):
    from reference_backend import ReferenceBackend, encode_last_token
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      TOKENIZERS_PARALLELISM="false")
    if os.path.exists(output):
        raise ValueError("report exists")
    manifest = bound_manifest(manifest_path)
    corpora, cases = load_corpora(corpus_paths)
    started = time.perf_counter()
    backend = ReferenceBackend(root, manifest, "mps")
    backend.encode = lambda row: encode_last_token(backend.model, row, "mps").cpu().numpy()
    startup = (time.perf_counter() - started) * 1000
    import torch
    captured = capture_mps(backend, corpora, cases)
    backend.unchanged()
    exclusive_write(output, {"kind": REPORT_KIND, "side": "mps", "identity": identity(manifest),
        "serverRevision": manifest["runtime"]["serverRevision"], "manifestSha256": sha(Path(manifest_path).read_bytes()),
        "tolerancesRevision": json.loads((FIXTURES / "clm-parity-tolerances.json").read_text())["revision"],
        "corpora": corpora, "host": {"system": platform.platform(), "python": platform.python_version(),
        "torch": torch.__version__, "device": "mps"}, "startupMs": startup,
        "gpuAllocatedBytes": torch.mps.current_allocated_memory(),
        "gpuDriverAllocatedBytes": torch.mps.driver_allocated_memory(), **captured,
        "fullReferenceParityQualified": False, "noExecutionAuthority": True})
    print(f"Captured {len(cases)} cases / {len(captured['texts'])} texts on MPS; compare against a reference capture.")


def main_capture_reference(checkout, root, endpoint, output, *corpus_paths):
    import requests
    import torch
    from fetch_artifacts import matches
    if os.path.exists(output):
        raise ValueError("report exists")
    manifest = json.loads((FIXTURES / "clm-artifact-manifest.macos.pending.json").read_text())
    if git("rev-parse", "HEAD", cwd=checkout) != manifest["referenceRevision"] or git("status", "--porcelain", cwd=checkout):
        raise ValueError("reference checkout is not the clean pinned revision")
    for file in manifest["encoder"]["files"] + manifest["heads"]["files"]:
        if not matches(Path(root) / file["path"], file):
            raise ValueError("artifact bytes differ from the pinned plan")
    # No arena; the embedder LRU is cleared before each timed repetition.
    os.environ["CLM_ACTION_CACHE"] = "0"
    sys.path.insert(0, str(Path(checkout) / "src"))
    from clm.embedder import Embedder
    from clm.engine import Engine
    from clm.schema import build_pairs
    corpora, cases = load_corpora(corpus_paths)
    embedder = Embedder(url=endpoint, model="qwen3-8b")
    engine = Engine(embedder=embedder, checkpoint=str(Path(root) / "heads/CLM_v0.1-8B.pt"), device="cuda")
    base = endpoint.rsplit("/v1/", 1)[0]

    def tokenize(text):
        reply = requests.post(f"{base}/tokenize", json={"model": "qwen3-8b", "prompt": text,
                              "add_special_tokens": True}, timeout=60)
        reply.raise_for_status()
        return int(reply.json()["count"])

    def embed(texts):
        return embedder.embed(texts)
    embed.clear = embedder.cache.clear
    captured = capture_reference(engine, embed, tokenize, cases, build_pairs)
    version = requests.get(f"{base}/version", timeout=10).json().get("version")
    exclusive_write(output, {"kind": REPORT_KIND, "side": "reference", "identity": identity(manifest),
        "tolerancesRevision": json.loads((FIXTURES / "clm-parity-tolerances.json").read_text())["revision"],
        "corpora": corpora, "host": {"system": platform.platform(), "python": platform.python_version(),
        "torch": torch.__version__, "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0),
        "vllm": version, "servedModels": requests.get(f"{base}/v1/models", timeout=10).json()},
        **captured, "noExecutionAuthority": True})
    print(f"Captured {len(cases)} reference cases; this is source evidence, never Mac qualification.")


def compare(reference, mps, tolerances, heads=None):
    import numpy as np
    for field in ("identity", "corpora", "tolerancesRevision"):
        if reference[field] != mps[field]:
            raise ValueError(f"captures disagree on {field}; not comparable")
    if tolerances["revision"] != reference["tolerancesRevision"]:
        raise ValueError("captures were made under different tolerances")
    e, d = tolerances["embedding"], tolerances["distribution"]
    texts, failures = [], []
    for digest, ref in reference["texts"].items():
        mine = mps["texts"].get(digest)
        if mine is None:
            failures.append({"text": digest, "reason": "missing on mps"}); continue
        a, b = (unvector(x["embedding"]).astype(np.float64) for x in (ref, mine))
        a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
        row = {"text": digest, "tokensReference": ref["tokens"], "tokensMps": mine["tokens"],
               "cosine": float(a @ b), "maxAbsElement": float(np.max(np.abs(a - b)))}
        texts.append(row)
        if row["tokensReference"] != row["tokensMps"]:
            failures.append({"text": digest, "reason": "token count"})
        if row["cosine"] < e["minCosine"] or row["maxAbsElement"] > e["maxAbsElement"]:
            failures.append({"text": digest, "reason": "embedding drift"})
    by_id = {(c["corpus"], c["caseId"]): c for c in mps["cases"]}
    cases = []
    for ref in reference["cases"]:
        mine = by_id.get((ref["corpus"], ref["caseId"]))
        if mine is None or mine["keys"] != ref["keys"] or mine["textSha256"] != ref["textSha256"]:
            failures.append({"case": ref["caseId"], "reason": "template or candidate text differs"}); continue
        p, q = np.array(ref["probabilities"]), np.array(mine["probabilities"])
        order = np.sort(p)[::-1]
        row = {"corpus": ref["corpus"], "caseId": ref["caseId"],
               "maxAbsProbabilityDifference": float(np.max(np.abs(p - q))),
               "referenceChoice": ref["keys"][int(np.argmax(p))], "mpsChoice": mine["keys"][int(np.argmax(q))],
               "referenceMargin": float(order[0] - order[1]),
               "deterministic": ref["probabilities"] == ref["repeatProbabilities"]
                                and mine["probabilities"] == mine["repeatProbabilities"]}
        if heads is not None:
            state, action, scale = heads
            def ours(side):
                import torch
                stacked = np.stack([unvector(side["texts"][t]["embedding"]) for t in ref["textSha256"]])
                return np.array(rank_embeddings(torch.from_numpy(stacked.copy()), state, action, scale, 1))
            via_ours = ours(reference)
            # Same CPU head over both sides' vectors: the remaining gap is encoder-only.
            row["headArithmeticDifference"] = float(np.max(np.abs(via_ours - p)))
            row["encoderOnlyDifference"] = float(np.max(np.abs(via_ours - ours(mps))))
            if row["headArithmeticDifference"] > tolerances["headArithmetic"]["maxAbsProbabilityDifference"]:
                failures.append({"case": ref["caseId"], "reason": "head arithmetic"})
        cases.append(row)
        if row["maxAbsProbabilityDifference"] > d["maxAbsProbabilityDifference"]:
            failures.append({"case": ref["caseId"], "reason": "distribution drift"})
        if (row["referenceChoice"] != row["mpsChoice"]
                and row["referenceMargin"] >= d["topChoiceMustAgreeWhenReferenceMarginAtLeast"]):
            failures.append({"case": ref["caseId"], "reason": "top choice"})
        if not row["deterministic"]:
            failures.append({"case": ref["caseId"], "reason": "repetition differs"})
    if {(c["corpus"], c["caseId"]) for c in reference["cases"]} != set(by_id):
        failures.append({"reason": "case sets differ"})
    summary = {"texts": len(texts), "cases": len(cases),
               "minCosine": min((t["cosine"] for t in texts), default=None),
               "maxAbsProbabilityDifference": max((c["maxAbsProbabilityDifference"] for c in cases), default=None),
               "topChoiceAgreement": sum(c["referenceChoice"] == c["mpsChoice"] for c in cases)}
    return {"kind": "clm-parity-comparison", "tolerancesRevision": tolerances["revision"],
            "tolerancesStatus": tolerances["status"], "withinCandidateTolerances": not failures,
            "ownerAcceptedTolerances": False, "fullReferenceParityQualified": False,
            "summary": summary, "failures": failures, "texts": texts, "cases": cases}


def main_compare(reference_path, mps_path, output, *rest):
    if os.path.exists(output):
        raise ValueError("report exists")
    reports = [json.loads(Path(p).read_text()) for p in (reference_path, mps_path)]
    if [r.get("kind") for r in reports] != [REPORT_KIND] * 2 or [r["side"] for r in reports] != ["reference", "mps"]:
        raise ValueError("expected a reference capture then an mps capture")
    heads = None
    if rest:
        if len(rest) != 2 or rest[0] != "--heads":
            raise ValueError("usage")
        from reference_backend import load_heads
        heads = load_heads(rest[1], "cpu")
    result = compare(*reports, json.loads((FIXTURES / "clm-parity-tolerances.json").read_text()), heads)
    exclusive_write(output, result)
    print(json.dumps(result["summary"]), "within candidate tolerances:", result["withinCandidateTolerances"])


if __name__ == "__main__":
    commands = {"capture-mps": main_capture_mps, "capture-reference": main_capture_reference, "compare": main_compare}
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        sys.exit(__doc__)
    commands[sys.argv[1]](*sys.argv[2:])
