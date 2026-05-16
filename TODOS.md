# TODOS

Deferred work, grouped by component then priority (P0 highest). The full
rationale lives in the kit-pipeline design doc; this is the in-repo summary.

## Kit pipeline

### Phase 2 — Step 5: batch + determinism
**Priority:** P2
**What:** `kit-batch <input-dir> <output-dir>` plus a byte-identical manifest.
**Why:** Process many images unattended with a reproducible bill-of-materials.
**Scope:**
- Per-image try/catch isolation (one bad image must not abort the batch).
- Streaming/bounded memory across the batch.
- Byte-identical `manifest.json` determinism across runs (same input + seed +
  catalog), including facet-pipeline determinism verification.
**Depends on:** Phase 1 step 4 — done (v2.2.0.0). A complete kit is now
produced per image; step 5 wraps it in a batch loop + manifest.

### Phase 2 — Step 6b: batch test coverage
**Priority:** P2
**What:** CI smoke for batch isolation + manifest determinism.
**Depends on:** Step 5.

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
