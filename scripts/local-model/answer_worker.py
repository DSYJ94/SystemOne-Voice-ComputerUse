"""On-device answers for SystemOne (Stage C): composes a short spoken answer to the user's
question using only the text read from their screen. No network once installed.

Reads one JSON request per line: {"id": "...", "question": "...", "text": "<screen text>"}
and answers: {"id": "...", "answer": "...", "ms": 540}. The host checks the answer against
the screen text before speaking it. Model: Llama-3.2-3B-Instruct (4-bit, MLX), chosen by
benchmark on this Mac (5/5 answers with the key facts, median 0.54 s; Qwen2.5-3B 4/5).
"""
import json
import sys
import time

MODEL = "mlx-community/Llama-3.2-3B-Instruct-4bit"
REVISION = "7f0dc925e0d0afb0322d96f9255cfddf2ba5636e"
SYSTEM = (
    "You answer a Mac user's question using only the text from their screen. Be brief: one or two short "
    "sentences that will be spoken aloud. Use only facts that appear in the text; never add anything. If the "
    "answer is not in the text, say: I can't see that on the screen."
)


def main() -> None:
    started = time.time()
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(MODEL, revision=REVISION)
    if "--download" in sys.argv:  # One-time install: fetch the pinned model, then exit.
        return
    sampler = make_sampler(temp=0.0)
    print(json.dumps({"ready": True, "loadMs": round((time.time() - started) * 1000)}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            prompt = tokenizer.apply_chat_template(
                [{"role": "system", "content": SYSTEM},
                 {"role": "user", "content": f"Text on screen:\n{str(request['text'])[:6000]}\n\nQuestion: {str(request['question'])[:600]}"}],
                add_generation_prompt=True, tokenize=False)
            began = time.time()
            out = generate(model, tokenizer, prompt=prompt, max_tokens=110, sampler=sampler, verbose=False)
            print(json.dumps({"id": request.get("id"), "answer": out.strip(),
                              "ms": round((time.time() - began) * 1000)}), flush=True)
        except Exception as error:  # One bad request never stops the worker.
            print(json.dumps({"id": None, "error": str(error)[:200]}), flush=True)


if __name__ == "__main__":
    main()
