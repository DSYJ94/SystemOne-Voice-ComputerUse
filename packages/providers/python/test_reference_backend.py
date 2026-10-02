"""CPU algorithm/tokenizer fixtures, never production model qualification."""
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch
from tokenizers import Tokenizer, models, pre_tokenizers, processors
from transformers import PreTrainedTokenizerFast

from reference_backend import (ReferenceBackend, encode_last_token, load_heads, make_head, pairs,
                               rank_embeddings, token_ids, verify_inventory)
from fetch_artifacts import fetch_file


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(91)
        torch.set_num_threads(1)

    def checkpoint(self, directory, **cfg):
        config = {"width": 12, "depth": 3, **cfg}
        state, action = make_head(config, 8), make_head(config, 8)
        path = Path(directory) / "heads.pt"
        torch.save({"cfg": config, "projection_dim": 8, "state_head": state.state_dict(),
                    "action_head": action.state_dict(), "logit_scale": torch.tensor(2.0)}, path)
        return path, state, action

    def test_head_and_scores_match_independent_reference_calculation(self):
        for activation in ("gelu", "relu", "silu"):
            for residual in (False, True):
                with self.subTest(activation=activation, residual=residual), tempfile.TemporaryDirectory() as directory:
                    path, original_state, original_action = self.checkpoint(directory, activation=activation,
                                                                          residual=residual, layernorm=True)
                    state, action, scale = load_heads(path, "cpu")
                    values = torch.randn(4, 4096)
                    actual = rank_embeddings(values, state, action, scale, 0.7)
                    array = values.numpy()
                    array = array / (np.linalg.norm(array, axis=-1, keepdims=True) + 1e-12)
                    def independent(head, x):
                        x = head.act(torch.nn.functional.linear(x, head.inp.weight, head.inp.bias))
                        for linear, norm in zip(head.hidden, head.norms):
                            h = head.act(norm(torch.nn.functional.linear(x, linear.weight, linear.bias)))
                            x = x + h if residual else h
                        x = torch.nn.functional.linear(x, head.out.weight, head.out.bias)
                        return x / torch.linalg.vector_norm(x, dim=-1, keepdim=True).clamp(min=1e-12)
                    with torch.no_grad():
                        zs = independent(original_state, torch.from_numpy(array[:1]))
                        za = independent(original_action, torch.from_numpy(array[1:]))
                        logits = (scale * (za @ zs[0]) / 0.7).tolist()
                    expected = np.exp(np.array(logits) - max(logits))
                    expected /= sum(expected)
                    np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-7)

    def test_real_tiny_qwen_model_pools_the_last_token(self):
        from transformers import Qwen3Config, Qwen3Model
        model = Qwen3Model(Qwen3Config(hidden_size=16, intermediate_size=32, num_hidden_layers=2,
            num_attention_heads=2, num_key_value_heads=1, head_dim=8, vocab_size=32)).eval()
        with torch.inference_mode():
            full = model(input_ids=torch.tensor([[1, 2, 3]]), use_cache=False).last_hidden_state
        actual = encode_last_token(model, [1, 2, 3], "cpu")
        torch.testing.assert_close(actual, full[0, 2])
        self.assertFalse(torch.allclose(actual, full[0, 0]))

    def test_scale_clamped_and_checkpoint_dimensions_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _, _ = self.checkpoint(directory)
            checkpoint = torch.load(path, weights_only=True)
            checkpoint["logit_scale"] = torch.tensor(1000.0)
            torch.save(checkpoint, path)
            self.assertEqual(load_heads(path, "cpu")[2], 100)
            checkpoint["cfg"]["hidden_size"] = 2
            torch.save(checkpoint, path)
            with self.assertRaises(ValueError): load_heads(path, "cpu")
            checkpoint["cfg"].pop("hidden_size")
            checkpoint["logit_scale"] = torch.tensor(float("nan"))
            torch.save(checkpoint, path)
            with self.assertRaises(ValueError): load_heads(path, "cpu")

    def test_unsafe_pickle_cannot_load(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unsafe.pt"
            torch.save({"cfg": Path("unapproved-pickle-class")}, path)
            with self.assertRaises(Exception): load_heads(path, "cpu")

    def tokenizer(self):
        raw = Tokenizer(models.WordLevel({"[UNK]": 0, "a": 1, "[BOS]": 2}, unk_token="[UNK]"))
        raw.pre_tokenizer = pre_tokenizers.Whitespace()
        raw.post_processor = processors.TemplateProcessing(single="[BOS] $A", special_tokens=[("[BOS]", 2)])
        return PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]")

    def test_real_fast_tokenizer_counts_special_tokens_without_truncation(self):
        tokenizer = self.tokenizer()
        self.assertEqual(token_ids(tokenizer, ["a a"]), [[2, 1, 1]])
        self.assertEqual(len(token_ids(tokenizer, ["a " * 2048])[0]), 2049)
        self.assertEqual(len(token_ids(tokenizer, ["a " * 2047])[0]), 2048)

    def test_worker_answer_rejects_overflow_before_model_call(self):
        backend = ReferenceBackend.__new__(ReferenceBackend)
        backend.fingerprints = {}
        backend.tokenizer = self.tokenizer()
        class NeverEncoder:
            def __call__(self, **kwargs): raise AssertionError("overflow reached encoder")
        backend.model = NeverEncoder()
        request = {"state": "a " * 2048, "model": "clm-latest", "questions": {"next_action": {
            "type": "choice", "instructions": "", "criteria": {"a": "a", "b": "b"}}}, "temperature": 1}
        with self.assertRaisesRegex(ValueError, "overflow"): backend.answer(request)

    def test_state_format_and_candidates_preserve_reference_whitespace(self):
        request = {"state": "\u0085 s \u0085", "model": "clm-latest", "questions": {"next_action": {
            "type": "choice", "instructions": "\n q \n", "criteria": {"a": "  candidate  ", "b": "other"}}},
            "temperature": 1}
        self.assertEqual(pairs(request), (["a", "b"], ["s\n\nq", "  candidate  ", "other"]))
        request["state"] = "\ufeffs"
        self.assertEqual(pairs(request)[1][0], "\ufeffs\n\nq")

    def test_zero_vectors_and_nonfinite_embeddings(self):
        cfg = {"width": 4, "depth": 2}
        state, action = make_head(cfg, 2), make_head(cfg, 2)
        values = torch.zeros(3, 4096)
        probabilities = rank_embeddings(values, state, action, 1, 1)
        self.assertAlmostEqual(sum(probabilities), 1)
        values[0, 0] = float("inf")
        with self.assertRaises(ValueError): rank_embeddings(values, state, action, 1, 1)

    def test_inventory_rejects_undeclared_files_and_mutated_bytes(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for component in ("encoder", "heads"): (root / component).mkdir()
            path = root / "encoder/config.json"
            path.write_bytes(b"{}")
            manifest = {"encoder": {"files": [{"path": "encoder/config.json", "bytes": 2,
                "sha256": hashlib.sha256(b"{}").hexdigest()}]}, "heads": {"files": []}}
            verify_inventory(root, manifest)
            alternate = root / "encoder/pytorch_model.bin"
            alternate.write_bytes(b"unreviewed")
            with self.assertRaisesRegex(ValueError, "undeclared"): verify_inventory(root, manifest)
            alternate.unlink()
            path.write_bytes(b"[]")
            with self.assertRaisesRegex(ValueError, "hash"): verify_inventory(root, manifest)

    def test_download_verification_preserves_existing_files_and_rejects_bad_bytes(self):
        import hashlib
        import io
        file = {"bytes": 3, "sha256": hashlib.sha256(b"pin").hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact"
            for bytes in (b"bad", b"too big", b"p"):
                with self.assertRaises(ValueError):
                    fetch_file("https://synthetic.invalid", path, file, lambda *a, **k: io.BytesIO(bytes))
                self.assertFalse(path.exists())
                self.assertEqual(list(Path(directory).glob("*.part")), [])
            fetch_file("https://synthetic.invalid", path, file, lambda *a, **k: io.BytesIO(b"pin"))
            self.assertEqual(path.read_bytes(), b"pin")
            fetch_file("https://synthetic.invalid", path, file, lambda *a, **k: self.fail("valid file downloaded twice"))
            path.write_bytes(b"old")
            with self.assertRaisesRegex(ValueError, "existing"):
                fetch_file("https://synthetic.invalid", path, file)
            self.assertEqual(path.read_bytes(), b"old")


if __name__ == "__main__":
    unittest.main()
