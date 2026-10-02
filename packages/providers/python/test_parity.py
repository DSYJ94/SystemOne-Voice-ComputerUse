"""CPU parity-harness fixtures. Synthetic vectors, never encoder qualification.

Set CLM_REFERENCE_CHECKOUT to a clean pinned upstream checkout to also run the
reference capture through the upstream Engine/Embedder against a stub vLLM server.
"""
import base64
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import numpy as np
import torch

import parity
from reference_backend import ReferenceBackend, load_heads, make_head

FIXTURES = Path(__file__).parents[1] / "fixtures"
CORPORA = [FIXTURES / n for n in ("clm-probe-synthetic.json", "clm-diagnostic-documents.json")]
TOLERANCES = json.loads((FIXTURES / "clm-parity-tolerances.json").read_text())


class ByteTokenizer:
    def encode(self, text, add_special_tokens=True, truncation=False):
        return [256, *text.encode("utf-8")]


def hidden_for(ids):
    seed = int.from_bytes(hashlib.sha256(json.dumps(ids).encode()).digest()[:8], "little")
    return torch.randn(4096, generator=torch.Generator().manual_seed(seed))


class FakeEncoder:
    """Last-token state is a deterministic function of the whole sequence."""
    def __call__(self, input_ids, attention_mask, use_cache, return_dict):
        ids = input_ids[0].tolist()
        rows = torch.stack([hidden_for(ids[:i + 1]) for i in range(len(ids))])
        return type("Out", (), {"last_hidden_state": rows[None].to(torch.bfloat16)})


def checkpoint(directory):
    cfg = {"width": 32, "depth": 3, "layernorm": True, "residual": True}
    state, action = make_head(cfg, 16), make_head(cfg, 16)
    path = Path(directory) / "heads.pt"
    torch.save({"cfg": cfg, "projection_dim": 16, "state_head": state.state_dict(),
                "action_head": action.state_dict(), "logit_scale": torch.tensor(2.5)}, path)
    return path


def fake_backend(heads_path):
    backend = ReferenceBackend.__new__(ReferenceBackend)
    backend.fingerprints, backend.tokenizer, backend.model, backend.device = {}, ByteTokenizer(), FakeEncoder(), "cpu"
    backend.state_head, backend.action_head, backend.scale = load_heads(heads_path, "cpu")
    from reference_backend import encode_last_token
    backend.encode = lambda row: encode_last_token(backend.model, row, "cpu").numpy()
    return backend


def mps_capture(heads_path, cases):
    with mock.patch.object(torch.cuda, "synchronize"), mock.patch.object(torch.cuda, "memory_allocated", return_value=0):
        captured = parity.capture_mps(fake_backend(heads_path), None, cases)
    return captured


def report(side, captured, corpora):
    return {"kind": parity.REPORT_KIND, "side": side, "identity": {"pin": "synthetic"}, "corpora": corpora,
            "tolerancesRevision": TOLERANCES["revision"], **captured}


class ParityTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(5)
        torch.set_num_threads(1)
        self.corpora, self.cases = parity.load_corpora(CORPORA)

    def test_requests_match_the_node_wire_encoder_byte_for_byte(self):
        script = ("import {readFileSync} from 'node:fs';"
                  "import {encodeCLMProviderView} from './packages/providers/src/clm-wire.ts';"
                  "const f = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                  "process.stdout.write(JSON.stringify(f.map(x => JSON.parse(Buffer.from("
                  "encodeCLMProviderView(x.providerView)).toString()))));")
        root = Path(__file__).parents[3]
        for corpus in CORPORA + [FIXTURES / "clm-calibration-synthetic.json"]:
            node = subprocess.run(["node", "--input-type=module", "-e", script, str(corpus)], cwd=root,
                                  capture_output=True, text=True, check=True).stdout
            ours = [parity.request_of(f["providerView"]) for f in json.loads(corpus.read_text())]
            self.assertEqual(json.loads(node), ours)

    def test_corpora_reject_duplicates_and_non_synthetic_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "c.json"
            fixture = json.loads(CORPORA[0].read_text())[0]
            path.write_text(json.dumps([fixture, fixture]))
            with self.assertRaises(ValueError): parity.load_corpora([path])
            path.write_text(json.dumps([{**fixture, "synthetic": False}]))
            with self.assertRaises(ValueError): parity.load_corpora([path])

    def test_mps_capture_records_the_vectors_the_serving_path_ranked(self):
        with tempfile.TemporaryDirectory() as directory:
            captured = mps_capture(checkpoint(directory), self.cases)
        self.assertEqual(len(captured["cases"]), len(self.cases))
        for case in captured["cases"]:
            self.assertTrue(case["capturedVectorsReproduce"])
            self.assertEqual(case["probabilities"], case["repeatProbabilities"])
            self.assertAlmostEqual(sum(case["probabilities"]), 1)
            self.assertEqual(len(case["projectedCosines"]), len(case["keys"]))
        record = next(iter(captured["texts"].values()))
        self.assertAlmostEqual(float(np.linalg.norm(parity.unvector(record["embedding"]))), 1, places=5)
        self.assertNotIn("_raw", record)

    def test_identical_encoders_pass_and_each_drift_kind_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            heads = checkpoint(directory)
            mine = report("mps", mps_capture(heads, self.cases), self.corpora)
            loaded = load_heads(heads, "cpu")
        result = parity.compare(copy.deepcopy(mine) | {"side": "reference"}, mine, TOLERANCES, loaded)
        self.assertTrue(result["withinCandidateTolerances"], result["failures"])
        self.assertFalse(result["fullReferenceParityQualified"] or result["ownerAcceptedTolerances"])
        # Stored vectors are already normalized; re-normalizing them in float32 moves
        # probabilities by ~1e-7, well inside the pre-registered head bound.
        self.assertLess(max(c["headArithmeticDifference"] for c in result["cases"]), 1e-6)

        drifted = copy.deepcopy(mine)
        digest = drifted["cases"][0]["textSha256"][0]
        vector = parity.unvector(drifted["texts"][digest]["embedding"]).copy()
        vector[:64] *= -1
        drifted["texts"][digest]["embedding"] = parity.vector(vector)
        reasons = {f["reason"] for f in parity.compare(drifted | {"side": "reference"}, mine, TOLERANCES)["failures"]}
        self.assertIn("embedding drift", reasons)

        tokens = copy.deepcopy(mine)
        tokens["texts"][digest]["tokens"] += 1
        self.assertIn("token count", {f["reason"] for f in parity.compare(tokens, mine, TOLERANCES)["failures"]})

        template = copy.deepcopy(mine)
        template["cases"][0]["textSha256"][0] = "0" * 64
        self.assertIn("template or candidate text differs",
                      {f["reason"] for f in parity.compare(template, mine, TOLERANCES)["failures"]})

        flipped = copy.deepcopy(mine)
        case = flipped["cases"][0]
        # A confident reference choice that is not the owned path's top choice.
        other = min(range(len(case["keys"])), key=case["probabilities"].__getitem__)
        case["probabilities"] = case["repeatProbabilities"] = [0.9 if i == other else 0.1 / (len(case["keys"]) - 1)
                                                                for i in range(len(case["keys"]))]
        reasons = {f["reason"] for f in parity.compare(flipped, mine, TOLERANCES)["failures"]}
        self.assertTrue({"distribution drift", "top choice"} <= reasons)

        unstable = copy.deepcopy(mine)
        unstable["cases"][0]["repeatProbabilities"] = [p * 0.999 for p in unstable["cases"][0]["probabilities"]]
        self.assertIn("repetition differs", {f["reason"] for f in parity.compare(unstable, mine, TOLERANCES)["failures"]})

        for field, value in (("identity", {"pin": "other"}), ("corpora", []), ("tolerancesRevision", "x")):
            with self.assertRaises(ValueError): parity.compare({**mine, field: value}, mine, TOLERANCES)

    def test_exclusive_report_refuses_overwrite_and_is_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "r.json"
            parity.exclusive_write(path, {"a": 1})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): parity.exclusive_write(path, {"a": 2})

    @unittest.skipUnless(os.environ.get("CLM_REFERENCE_CHECKOUT"), "pinned upstream checkout not provided")
    def test_upstream_engine_capture_agrees_with_the_owned_path_on_identical_vectors(self):
        checkout = Path(os.environ["CLM_REFERENCE_CHECKOUT"])
        pinned = json.loads((FIXTURES / "clm-artifact-manifest.macos.pending.json").read_text())["referenceRevision"]
        self.assertEqual(parity.git("rev-parse", "HEAD", cwd=checkout), pinned)
        tokenizer = ByteTokenizer()

        class VLLMStub(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/tokenize":
                    reply = {"count": len(tokenizer.encode(body["prompt"]))}
                else:
                    self.server.requests.append(body)
                    # vLLM pooling: bf16 last-token state, normalized, float32 base64.
                    data = []
                    for i, text in enumerate(body["input"]):
                        h = hidden_for(tokenizer.encode(text)).to(torch.bfloat16).float()
                        h = torch.nn.functional.normalize(h, dim=-1).numpy().astype("<f4")
                        data.append({"index": i, "embedding": base64.b64encode(h.tobytes()).decode()})
                    reply = {"data": data, "usage": {"prompt_tokens": 0}}
                payload = json.dumps(reply).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(payload))); self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), VLLMStub)
        server.requests = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        sys.path.insert(0, str(checkout / "src"))
        try:
            from clm.embedder import Embedder
            from clm.engine import Engine
            from clm.schema import build_pairs
            import requests
            with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"CLM_ACTION_CACHE": "0"}):
                heads = checkpoint(directory)
                url = f"http://127.0.0.1:{server.server_port}"
                embedder = Embedder(url=f"{url}/v1/embeddings", model="qwen3-8b")
                engine = Engine(embedder=embedder, checkpoint=str(heads), device="cpu")

                def embed(texts): return embedder.embed(texts)
                embed.clear = embedder.cache.clear
                tokenize = lambda text: requests.post(f"{url}/tokenize", json={"prompt": text}).json()["count"]
                ref = report("reference", parity.capture_reference(engine, embed, tokenize, self.cases, build_pairs),
                             self.corpora)
                mine = report("mps", mps_capture(heads, self.cases), self.corpora)
                result = parity.compare(ref, mine, TOLERANCES, load_heads(heads, "cpu"))
        finally:
            server.shutdown()
            sys.path.remove(str(checkout / "src"))
        self.assertTrue(all(r["truncate_prompt_tokens"] == 2048 for r in server.requests))
        # Identical encoder states: only bf16 vLLM normalization and head device math differ.
        self.assertTrue(result["withinCandidateTolerances"], result["failures"])
        self.assertGreater(result["summary"]["minCosine"], 0.99999)
        self.assertEqual(result["summary"]["topChoiceAgreement"], len(self.cases))


if __name__ == "__main__":
    unittest.main()
