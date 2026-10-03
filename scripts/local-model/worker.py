"""On-device "understanding" model for SystemOne (no network once installed).

Reads one JSON request per line on stdin: {"id": "...", "text": "<what the user said>"}
and answers on stdout: {"id": "...", "answer": "<words to type, or NONE>", "ms": 41}.
The host only accepts an answer that is exactly a run of the user's own words, so the
model can never put new text on screen. Model: Qwen2.5-0.5B-Instruct (4-bit, MLX),
chosen by benchmark (17/22 on the labelled set, median 41 ms on an M5).
"""
import json
import sys
import time

MODEL = "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
REVISION = "a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3"

SYSTEM = (
    "You extract text for a Mac assistant. Input: a spoken request. Output: only the exact words from "
    "the request that should be typed into a search box, message or note, copied exactly. Never add words. "
    "Instruction words are never typed: go to, search, look up, find, play, open, click, tell, reply, message, "
    "text, send, saying, app or site names, and the person's name. If nothing should be typed, output NONE."
)
SHOTS = [
    ("youtube search jazz piano play the first one", "jazz piano"),
    ("go to youtube search jazz piano find me the one with the most likes", "jazz piano"),
    ("search google for weather in paris, then open the first result", "weather in paris"),
    ("text mum on whatsapp I'm on the train", "I'm on the train"),
    ("reply to Alex I will call later", "I will call later"),
    ("slack Jo see you soon", "see you soon"),
    ("open the email from Bob about the contract", "NONE"),
    ("reply in this chat", "NONE"),
    ("switch to Mail and open the inbox", "NONE"),
    ("open spotify", "NONE"),
]


def main() -> None:
    started = time.time()
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(MODEL, revision=REVISION)
    if "--download" in sys.argv:  # One-time install: fetch the pinned model, then exit.
        return
    sampler = make_sampler(temp=0.0)
    base = [{"role": "system", "content": SYSTEM}]
    for question, answer in SHOTS:
        base += [{"role": "user", "content": question}, {"role": "assistant", "content": answer}]
    print(json.dumps({"ready": True, "loadMs": round((time.time() - started) * 1000)}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            text = str(request["text"])[:1200]
            prompt = tokenizer.apply_chat_template(base + [{"role": "user", "content": text}],
                                                   add_generation_prompt=True, tokenize=False)
            began = time.time()
            out = generate(model, tokenizer, prompt=prompt, max_tokens=24, sampler=sampler, verbose=False)
            answer = out.strip().split("\n")[0].strip(" \"'“”.")
            print(json.dumps({"id": request.get("id"), "answer": answer,
                              "ms": round((time.time() - began) * 1000)}), flush=True)
        except Exception as error:  # One bad request never stops the worker.
            print(json.dumps({"id": None, "error": str(error)[:200]}), flush=True)


if __name__ == "__main__":
    main()
