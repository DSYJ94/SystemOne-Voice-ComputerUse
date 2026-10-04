"""On-device screen grounding for SystemOne (Stage D): given a screenshot of the window
being used and what to do, returns the point to click. Works alongside Jev: Jev still
decides each step; this is used only when Jev chooses "find it on screen" for an app
whose controls cannot be read. No network once installed; images are deleted by the
host after each call.

Request per line: {"id": "...", "image": "<png path>", "instruction": "..."}
Reply: {"id": "...", "x": <px>, "y": <px>, "ms": 2600} in the image's own pixels, or
{"id": "...", "error": "..."}. Model: UI-TARS-1.5-7B (4-bit, MLX), chosen by benchmark
(ScreenSpot-v2, 100 samples: 88% hits, icons 78%; median 2.6 s on an M5).
"""
import json
import math
import os
import re
import sys
import tempfile
import time

MODEL = "mlx-community/UI-TARS-1.5-7B-4bit"
REVISION = "cca0e360e25322cdf480cf841e301b6d55bce9e0"
MAX_PIXELS = 1280 * 28 * 28  # resize here so the model's own resize does not change coordinates


def main() -> None:
    started = time.time()
    from mlx_vlm import generate, load
    from mlx_vlm.prompt_utils import apply_chat_template
    from PIL import Image

    model, processor = load(MODEL, revision=REVISION)
    if "--download" in sys.argv:
        return
    print(json.dumps({"ready": True, "loadMs": round((time.time() - started) * 1000)}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            image = Image.open(request["image"]).convert("RGB")
            w, h = image.size
            scale = min(1.0, math.sqrt(MAX_PIXELS / (w * h)))
            nw, nh = max(28, int(w * scale) // 28 * 28), max(28, int(h * scale) // 28 * 28)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
                image.resize((nw, nh), Image.LANCZOS).save(handle.name)
                resized = handle.name
            prompt = apply_chat_template(processor, model.config,
                "Output only the coordinate of one point in your response. What element matches the following task: "
                + str(request["instruction"])[:600], num_images=1)
            began = time.time()
            out = generate(model, processor, prompt, image=[resized], max_tokens=40, temperature=0.0, verbose=False)
            os.unlink(resized)
            text = out.text if hasattr(out, "text") else str(out)
            numbers = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", re.sub(r"start_box|point_2d", "", text))]
            if len(numbers) < 2:
                raise ValueError(f"no point in {text[:60]!r}")
            x, y = numbers[0], numbers[1]
            if x <= 1.0 and y <= 1.0:
                x, y = x * nw, y * nh
            print(json.dumps({"id": request.get("id"), "x": x * w / nw, "y": y * h / nh,
                              "ms": round((time.time() - began) * 1000)}), flush=True)
        except Exception as error:  # One bad request never stops the worker.
            print(json.dumps({"id": request.get("id"), "error": str(error)[:200]}), flush=True)


if __name__ == "__main__":
    main()
