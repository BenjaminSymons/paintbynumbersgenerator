# TODOS

Deferred work, grouped by component then priority (P0 highest). The full
rationale lives in the kit-pipeline design doc; this is the in-repo summary.

## Kit pipeline

### Phase 1 — Step 4: print-ready PDF
**Priority:** P1
**What:** Turn the numbered SVG + shopping list into a real printable kit PDF.
**Why:** Steps 1-3 produce the data (numbered canvas SVG, paint list); a painter
still can't print a usable kit without this.
**Scope:**
- `svg-to-pdfkit` + `pdfkit` (decision recorded in the design doc's step-0
  spike; bundle a libre TTF e.g. DejaVu Sans and register it with PDFKit for
  deterministic, non-substituted label glyphs).
- Physical sizing: real `viewBox` + mm, `--dpi`, `--paper`; canvas→paper scale.
- Min-printable-facet legibility guard: suppress numbers too small to paint at
  the chosen physical size; recover via the swatch legend.
- Swatch legend page (number + sku + name + swatch per paint).
- Minimal sheet-alignment marks for tiled multi-page output (corner ticks +
  seam labels); full bleed/registration deferred to a later pass.
**Depends on:** none (builds on shipped steps 1-3).

### Phase 2 — Step 5: batch + determinism
**Priority:** P2
**What:** `kit-batch <input-dir> <output-dir>` plus a byte-identical manifest.
**Why:** Process many images unattended with a reproducible bill-of-materials.
**Scope:**
- Per-image try/catch isolation (one bad image must not abort the batch).
- Streaming/bounded memory across the batch.
- Byte-identical `manifest.json` determinism across runs (same input + seed +
  catalog), including facet-pipeline determinism verification.
**Depends on:** Phase 1 step 4 (a kit must be fully produced before batching it).

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
