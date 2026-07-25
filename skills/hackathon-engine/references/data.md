# Data — a real insight, honestly shown

For Archetype C (data/ML/analytics) and any project whose value is a finding, a model, or a metric. The
win is **one true, non-obvious insight shown clearly** — not a dashboard of ten mediocre charts.

## Source & trust the data first
- Prefer **primary / official datasets** (the org's own data, government portals, documented APIs) over
  scraped or third-hand sets. Record where each dataset came from and its date (provenance = credibility).
- **Look before you model.** Row counts, value ranges, missing/null rates, obvious duplicates, units,
  time zones. Most wrong conclusions come from unexamined data, not bad math.
- Keep a raw copy; do cleaning in code (a script/notebook), never by hand-editing the source — so it's
  reproducible from zero on the judge's machine.

## Analyse with honesty (this is where slop and cheating hide)
- **Every headline number needs a witnessed computation** (Stage 5 of the engine applied to data): the
  number comes from code you ran on the real data, not an estimate or the model's guess.
- State assumptions and caveats out loud (sample size, selection bias, confounders). Overclaiming is the
  fastest way to lose credibility with technical judges.
- Correlation is not cause — say "associated with", not "causes", unless you actually have the design for it.
- Sanity-check against a known baseline; if a result seems too good, it usually is — find the leak.

## Show ONE thing well
- Pick the single most surprising, decision-relevant finding and build the demo around it.
- Load the **`dataviz` skill** for the chart itself — one well-crafted hero visualization (clear
  encoding, honest axes, an emphasized point) beats a wall of default plots.
- Design restraint (see `design-engine.md`): let the data read; label directly; no chartjunk.

## ML, if the task is a model
- A strong, simple baseline first (it's often competitive and always the honest reference). Report the
  metric that matches the task, on a **held-out** set — never training-set numbers.
- Note data leakage checks, the eval split, and the metric's limits. Reproducibility: a seed + a script
  that reruns the result from raw data.

## Stack (see golden-stacks.md)
Python + pandas/polars for analysis, a notebook for exploration, then Streamlit/Gradio or a small web
app for the demo. Precompute anything slow so the live demo is instant and can't hang.

## Verify
Rerun the pipeline from raw → result on a clean checkout; confirm every presented number reproduces.
An analysis that "should be right" is not a result.
