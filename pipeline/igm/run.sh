#!/usr/bin/env bash
# Run the glacier projections with IGM (https://github.com/instructed-glacier-model/igm).
# IGM lives in an environment of its own (it pulls in TensorFlow):
#   uv venv --python 3.12 data/igm/.venv && uv pip install --python data/igm/.venv/bin/python igm-model
# Each run takes a few minutes on a laptop CPU and writes data/igm/aletsch/<scenario>/output.nc,
# which pipeline/future.py turns into frames for the viewer.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
for config in "$root"/pipeline/igm/aletsch_*.yaml; do
  scenario="$(basename "$config" .yaml)"
  scenario="${scenario#aletsch_}"
  work="$root/data/igm/aletsch/$scenario"
  mkdir -p "$work/experiment"
  cp "$config" "$work/experiment/params.yaml"
  rm -rf "$work/outputs"
  (cd "$work" && "$root/data/igm/.venv/bin/igm_run" +experiment=params > run.log 2>&1)
  cp "$(find "$work/outputs" -name output.nc | tail -1)" "$work/output.nc"
  echo "$scenario: $(du -h "$work/output.nc" | cut -f1)"
done
