# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project uses a
four-digit `MAJOR.MINOR.PATCH.MICRO` version in the `VERSION` file.

## [2.1.0.0] - 2026-05-17

### Added
- **Paint catalog kit mode (Phase 1).** Point the CLI at a paint catalog and the
  generated colors snap to real, purchasable paints instead of arbitrary RGB:
  - `--catalog <file>` — a JSON catalog of `{ sku, name, rgb }` paints. A
    bundled `src-cli/catalogs/generic-acrylic-24.json` is included as a clearly
    labelled example; supply your own for real brand SKUs.
  - `--colors <N>` — number of paint regions, decoupled from catalog size.
  - `--canvas-size <WxH>` (cm) and `--coverage <tubes/cm²>` — drive a
    paint-quantity estimate.
  - Emits `*-shopping-list.csv` and `*-shopping-list.md`: numbered paint list
    with SKU, name, swatch hex, area %, and estimated tube count.
  - Canvas numbers and the shopping list share one stable `1..N` numbering;
    paints that end up unused are filtered out (no phantom entries, no gaps).
  - Colors that no catalog paint matches well are flagged out-of-gamut (with a
    warning) using the worst-case match so a good region can't mask a bad one.
- Catalog validation rejects malformed files, duplicate SKUs, duplicate RGBs,
  and oversized catalogs with clear errors.
- `scripts/kit-smoke.mjs` integration test (run via `npm run test:kit`), wired
  into CI.

### Fixed
- CLI no longer crashes on a degenerate single-colour image (unguarded
  `reduce` / divide-by-zero in palette generation).
- The CLI now exits non-zero on error instead of always reporting success, so
  CI and scripts can detect a failed run.

### Changed
- Partial settings files now fall back to defaults instead of leaving fields
  undefined (settings are merged onto a real defaults instance).
