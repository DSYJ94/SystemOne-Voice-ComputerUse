# Vision fallback benchmark

Compares ways of finding what to click in a screenshot, on ScreenSpot-v2 (real desktop
and web screenshots, each with an instruction and the correct target box). A hit means
the click lands inside the box. Data and models stay outside the repository.

```sh
export VISION_BENCH_DIR=~/systemone-vision-bench           # any folder outside the repo
python3 -m venv $VISION_BENCH_DIR/venv && $VISION_BENCH_DIR/venv/bin/pip install mlx-vlm huggingface_hub
# 1. Download ScreenSpot-v2 (desktop + web json, images zip) into $VISION_BENCH_DIR and unzip,
#    then write sample.json (the 4 Oct run: 50 desktop incl. 30 macOS, 50 web; half text, half icon; seed 7).
# 2. OCR + Jev (what SystemOne uses): Apple Vision text recognition, Jev picks the text.
swiftc -O -parse-as-library -o $VISION_BENCH_DIR/ocr scripts/vision-bench/ocr.swift && $VISION_BENCH_DIR/ocr $VISION_BENCH_DIR
node scripts/vision-bench/ocr-jev.ts
# 3. Vision-language models via MLX, asked directly for the point to click.
$VISION_BENCH_DIR/venv/bin/python scripts/vision-bench/vlm.py mlx-community/UI-TARS-1.5-7B-4bit
```

Results are recorded in docs/V1_PLAN.md (Stage D).
