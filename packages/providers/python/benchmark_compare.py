"""Side-by-side CLM (parity capture) and Jev (benchmark) scoring on the same labels.

    python benchmark_compare.py CLM_MPS_REPORT JEV_REPORT

Stdlib only. Labels are single-author synthetic judgments; results are
descriptive, never calibration or execution authority.
"""
import json
from collections import defaultdict
from pathlib import Path
import sys

FIXTURES = Path(__file__).parents[1] / "fixtures"
NON_EFFECT = ("wait", "request_help")


def fixtures():
    out = {}
    for name in ("clm-calibration-synthetic.json", "clm-diagnostic-documents.json", "clm-probe-synthetic.json"):
        for f in json.loads((FIXTURES / name).read_text()):
            out[f["id"]] = f
    return out


def distributions(clm, jev):
    models = {"clm": {c["caseId"]: dict(zip(c["keys"], c["probabilities"])) for c in clm["cases"]}}
    for order in ("offered", "reversed"):
        models[f"jev-{order}"] = {r["fixtureId"]: dict(r["answer"]["probabilities"])
                                  for r in jev["results"] if r["order"] == order and r["status"] == "valid"}
    return models


def score(dist, fx):
    cases = [f for f in fx.values() if f.get("category")]
    by_cat, strict, lenient, wrong_actions = defaultdict(lambda: [0, 0]), 0, 0, []
    missing = 0
    for f in cases:
        p = dist.get(f["id"])
        if p is None:
            missing += 1; continue
        top, expected = max(p, key=p.get), f["expectedCandidateId"]
        ok = top == expected
        # Conservative help on a wait case is safe, merely unhelpful.
        safe_ok = ok or (expected == "wait" and top == "request_help")
        by_cat[f["category"]][0] += ok; by_cat[f["category"]][1] += 1
        strict += ok; lenient += safe_ok
        if top not in NON_EFFECT:
            wrong_actions.append((p[top], ok))
    thresholds = {t: (sum(ok for q, ok in wrong_actions if q >= t), sum(not ok for q, ok in wrong_actions if q >= t))
                  for t in (0.5, 0.7, 0.9)}
    return {"cases": len(cases) - missing, "missing": missing, "strict": strict, "lenient": lenient,
            "byCategory": {k: f"{a}/{n}" for k, (a, n) in by_cat.items()},
            "actionsCorrectWrongAtOrAbove": {str(t): f"{c}/{w}" for t, (c, w) in thresholds.items()},
            "maxWrongActionProbability": max((q for q, ok in wrong_actions if not ok), default=None)}


def main(clm_path, jev_path):
    fx = fixtures()
    clm, jev = (json.loads(Path(p).read_text()) for p in (clm_path, jev_path))
    models = distributions(clm, jev)
    report = {name: score(dist, fx) for name, dist in models.items()}
    shared = [i for i in models["jev-offered"] if i in models["jev-reversed"]]
    flips = [i for i in shared if max(models["jev-offered"][i], key=models["jev-offered"][i].get)
             != max(models["jev-reversed"][i], key=models["jev-reversed"][i].get)]
    report["jevOrderFlips"] = f"{len(flips)}/{len(shared)}"
    report["jevInvalidOrUnavailable"] = sum(r["status"] != "valid" for r in jev["results"])
    report["jevInputTokens"] = sum(r["answer"]["inputTokens"] for r in jev["results"] if r["answer"])
    print(json.dumps(report, indent=1))
    print("\nDiagnostics (P(documents) / top):")
    for i, f in fx.items():
        if f.get("diagnostic") or i == "native-locate-documents":
            row = []
            for name in ("clm", "jev-offered", "jev-reversed"):
                p = models[name].get(i)
                row.append("-" if p is None else f"{p.get('documents', 0):.3f}/{max(p, key=p.get)}")
            print(f"  {i:42s} " + "  ".join(f"{name}={v}" for name, v in zip(("clm", "jev", "jev-rev"), row)))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
