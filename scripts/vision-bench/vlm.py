import json, re, sys, time, math, os
from PIL import Image
from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
ROOT = os.environ['VISION_BENCH_DIR']  # data folder (see README.md), kept outside the repository
sample = json.load(open(os.path.join(ROOT, 'sample.json')))
name = sys.argv[1]; limit = int(sys.argv[2]) if len(sys.argv) > 2 else len(sample)
MAX_PIXELS = 1280 * 28 * 28   # keep the model's own resize from changing the image again

def resized(path):
    im = Image.open(path).convert('RGB'); w, h = im.size
    scale = min(1.0, math.sqrt(MAX_PIXELS / (w * h)))
    nw = max(28, int(w * scale) // 28 * 28); nh = max(28, int(h * scale) // 28 * 28)
    out = os.path.join(ROOT, 'resized', os.path.basename(path)); os.makedirs(os.path.dirname(out), exist_ok=True)
    if not os.path.exists(out): im.resize((nw, nh), Image.LANCZOS).save(out)
    return out, w, h, nw, nh

def prompt_for(instr):
    if 'UI-TARS' in name:
        return f"Output only the coordinate of one point in your response. What element matches the following task: {instr}"
    if 'ShowUI' in name:
        return ("Based on the screenshot of the page, I give a text description and you give its corresponding location. "
                "The coordinate represents a clickable location [x, y] for an element, which is a relative coordinate on the "
                f"screenshot, scaled from 0 to 1.\n{instr}")
    return f"Find the UI element to click for: \"{instr}\". Reply only with its centre point as JSON: {{\"point_2d\": [x, y]}}"

def parse(text, nw, nh):
    nums = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?', re.sub(r'point_2d|bbox_2d|start_box', '', text))]
    if len(nums) < 2: return None
    x, y = nums[0], nums[1]
    if 'ShowUI' in name or (x <= 1.0 and y <= 1.0): return x * nw, y * nh
    return x, y

model, processor = load(name)
config = model.config
hits = {'text': [0, 0], 'icon': [0, 0]}; times = []; rows = []
for i, item in enumerate(sample[:limit]):
    path, w, h, nw, nh = resized(os.path.join(ROOT, 'screenspotv2_image', item['img_filename']))
    prompt = apply_chat_template(processor, config, prompt_for(item['instruction']), num_images=1)
    s = time.time()
    out = generate(model, processor, prompt, image=[path], max_tokens=40, temperature=0.0, verbose=False)
    ms = (time.time() - s) * 1000
    text = out.text if hasattr(out, 'text') else str(out)
    point = parse(text, nw, nh)
    x, y = (point[0] * w / nw, point[1] * h / nh) if point else (-1, -1)
    b = item['bbox']; hit = b[0] <= x <= b[0] + b[2] and b[1] <= y <= b[1] + b[3]
    hits[item['data_type']][0] += hit; hits[item['data_type']][1] += 1; times.append(ms)
    rows.append({'i': i, 'type': item['data_type'], 'split': item['split'], 'hit': hit, 'ms': ms, 'out': text[:80]})
    if limit <= 5: print(f"  {ms:6.0f} ms hit={hit} {item['instruction'][:50]!r} -> {text.strip()[:70]!r} bbox={b} pt=({x:.0f},{y:.0f}) img={w}x{h}")
json.dump(rows, open(os.path.join(ROOT, f"result-{name.split('/')[-1]}.json"), 'w'))
times.sort()
pct = lambda t: round(100 * hits[t][0] / max(1, hits[t][1]))
print(f"{name}: text {pct('text')}%, icon {pct('icon')}%, overall {round(100*(hits['text'][0]+hits['icon'][0])/max(1,len(rows)))}%; median {times[len(times)//2]:.0f} ms, p90 {times[int(len(times)*0.9)]:.0f} ms (n={len(rows)})")
