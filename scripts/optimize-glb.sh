#!/usr/bin/env bash
# Shrink a tessellated STEP->GLB export to web size: weld, simplify to ~4% of the
# triangles, Draco-compress. Usage: scripts/optimize-glb.sh in.glb out.glb
set -euo pipefail
npx --yes @gltf-transform/cli optimize "$1" "$2" --simplify-ratio 0.04 --simplify-error 0.002 --compress draco --texture-compress false --instance false
