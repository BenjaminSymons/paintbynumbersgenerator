# TODOS

Deferred work, grouped by component then priority (P0 highest). The full
rationale lives in the kit-pipeline design doc; this is the in-repo summary.

## Kit pipeline

The kit pipeline (design doc Phase 1 + Phase 2) is complete. Remaining items
are the design doc's open questions, not blocked work:

- `COVERAGE_CONST` (tube-count default `0.0025`) wants one real-world sanity
  check against an actual painted canvas. The documented default is acceptable
  and `--coverage`-overridable until then.
- The out-of-gamut ΔE threshold (`10`) is a starting guess; tune once real
  photos have been run against a real catalog.
- Manifest determinism is proven *same-environment* only. Cross-platform /
  cross-libvips byte-identity is explicitly out of scope (canvas/sharp pixel
  variance) and is documented as such, not a TODO.

## Completed

- Kit pipeline Phase 1, steps 1-3 (catalog format + loader, `--catalog` /
  `--colors` / `--canvas-size` / `--coverage` flags, post-snap color model with
  out-of-gamut flagging, 1..N renumber, phantom filter, shopping-list CSV/MD)
  plus the step-6a smoke suite. **Completed:** v2.1.0.0 (2026-05-17)
- CLI reduce/divide-by-zero crash guard and non-zero error exit.
  **Completed:** v2.1.0.0 (2026-05-17)
- Kit pipeline Phase 1 step 4: print-ready `*-kit.pdf` (tiled true-size canvas,
  colored cover, swatch legend), `--paper` / `--dpi` flags, SVG `viewBox`,
  print-legibility guard, corner crop ticks + seam labels, plus `*-cover.png` /
  `*-canvas.svg` deliverables and the step-4 smoke checks.
  **Completed:** v2.2.0.0 (2026-05-17)
- Kit pipeline Phase 2 (steps 5 + 6b): `kit-batch` subcommand with per-image
  isolation, streaming bounded memory, and a byte-identical aggregate
  `manifest.json` (`generateKit()` refactor shared with single mode); the two
  CRITICAL batch smoke checks. Determinism verified by a throwaway spike.
  **Completed:** v2.3.0.0 (2026-05-17)
