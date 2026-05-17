# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A paint-by-numbers generator: converts any raster image into a vectorized (SVG)
paint-by-numbers picture. One shared image-processing algorithm in `src/`, two
front-ends: a browser app and a CLI. Modernized fork of a 2019 proof of concept;
the algorithm is unchanged from the original, the toolchain is not.

## Commands

Node 20+, ESM (`"type": "module"`). Build output is produced by **esbuild**
(`scripts/build.mjs`), not by `tsc` — `tsc` is typecheck-only.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build web app + serve at http://127.0.0.1:10001, rebuild on change |
| `npm start` | Build web app + serve once |
| `npm run build:web` | Bundle browser app → `scripts/main.js` |
| `npm run build:cli` | Bundle CLI → `dist/cli.js` |
| `npm run build` | Both |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint (flat config, `eslint.config.mjs`) |
| `npm run check` | typecheck + lint + build — run before committing |

Run the CLI: `node dist/cli.js -i input.png -o output.svg -c src-cli/settings.json`

### Testing

There is **no unit test framework**. The only automated test is a CLI smoke
test in `.github/workflows/main.yml` (build the CLI, run it on
`src-cli/testinput.png`, assert the output files are non-empty). Add new tests
by extending that smoke job — do not introduce jest/vitest for a single check.
To run the smoke test locally, replicate the workflow steps: `npm run build:cli`
then run the CLI and check the outputs exist.

## Architecture

The pipeline is a fixed sequence of stages, each in its own `src/` module,
operating on `ImageData` then on facet data structures:

```
image → k-means color reduction → facet creation → facet reduction
      → (optional narrow-pixel-strip cleanup, iterative)
      → border tracing → border segmentation → label placement → SVG
```

| Stage | Module |
| --- | --- |
| Color quantization (k-means) | `src/colorreductionmanagement.ts` |
| Contiguous same-color regions | `src/facetCreator.ts` |
| Remove/merge small facets | `src/facetReducer.ts` |
| Trace facet borders | `src/facetBorderTracer.ts` |
| Reduce border points (Haar wavelet) | `src/facetBorderSegmenter.ts` |
| Place the number labels | `src/facetLabelPlacer.ts` (uses `src/lib/polylabel.ts`) |

`src/settings.ts` is the single config object threaded through every stage.

### Two front-ends, duplicated orchestration (important)

The stage *modules* are shared, but the code that *sequences* them is duplicated:

- **Web**: `src/main.ts` + `src/gui.ts` (jQuery + materialize-css), orchestrated
  by `GUIProcessManager.process()` in `src/guiprocessmanager.ts`. Bundled to
  `scripts/main.js`, loaded by `index.html`.
- **CLI**: `src-cli/main.ts` — the same sequence inlined into one `main()`.
  Bundled to `dist/cli.js` (the `paint-by-numbers-generator` bin).

`createSVG` exists in **both** `guiprocessmanager.ts` and `src-cli/main.ts`. A
pipeline or SVG change must be mirrored in both places or the web and CLI
outputs diverge. This duplication is a known wart, not an intentional boundary.

### Color restriction is post-snap, not constrained clustering

`settings.kMeansColorRestrictions` + `settings.colorAliases` do **not** constrain
k-means. K-means runs free with `kMeansNrOfClusters` clusters; afterwards, in
`ColorReducer.updateKmeansOutputImageData`, each resulting centroid is snapped
to the nearest restricted color by CIE76 Lab distance. Consequences: the number
of distinct colors in the output is driven by cluster count, not catalog size;
the snap distance is computed and discarded locally (not surfaced anywhere).

### Determinism

`settings.randomSeed` seeds the k-means RNG (`src/random.ts`). `randomSeed: 0`
means time-based (non-deterministic). The facet stages' determinism is not
verified — assume same-seed reproducibility only for the color step unless
proven otherwise.

### CLI specifics

- Settings are parsed as a raw `JSON.parse(...) as CLISettings` cast
  (`src-cli/main.ts`) — there is no merge against `Settings` defaults, so a
  partial settings file behaves unpredictably. This is deliberate for safety
  (settings can never execute code) but means every used key must be present.
- `node-canvas` `ImageData` lacks the DOM-only `colorSpace` field; the CLI
  bridges the two typings with explicit `as unknown as ImageData` casts.
- `outputProfiles` in the settings JSON drive multiple renders (svg/png/jpg)
  from one run; PNG/JPG go through `sharp`.
- Kit mode (`--catalog`) also emits a print-ready `*-kit.pdf` via
  `src-cli/kitpdf.ts` (`pdfkit` + `svg-to-pdfkit`). `pdfkit` must stay an
  esbuild `external` (it reads its AFM font metrics from its own package dir at
  runtime); labels use the PDF core font Helvetica deliberately (deterministic,
  no vendored binary). The CLI `createSVG` now emits a `viewBox` (required for
  PDF scaling) and takes a `minLabelPx` print-legibility guard — the web
  `createSVG` in `guiprocessmanager.ts` does NOT have these (kit mode is
  CLI-only, so this is an intentional divergence, not the duplication wart).
- The single-image kit path is `generateKit()`; `kit-batch <in> <out>`
  (positional subcommand, dispatched on `args._[0]`) reuses it per image with
  `quiet:true`. Options are parsed once via `parseKitOptions()`.
- Batch determinism contract: the aggregate `manifest.json` is byte-identical
  across runs **in the same environment** only. The per-image `sha256` hashes
  the proven-deterministic artifacts (palette JSON + shopping list + canvas
  SVG) and deliberately excludes the PDF (pdfkit embeds a timestamp/file-id).
  The whole logical pipeline (k-means + facet stages + sharp PNG) was verified
  byte-deterministic same-machine; cross-platform byte-identity is out of
  scope (canvas/sharp pixel variance). If a determinism test ever fails,
  treat it as an investigation, not a quick patch.

## Conventions

- TypeScript strict-ish, ESLint flat config. Run `npm run check` before commit;
  CI (`.github/workflows/main.yml`) runs typecheck + lint + build + CLI smoke.
- `dist/` and `scripts/main.js` are build artifacts; `test-output/` is gitignored.
- The image-processing algorithm is intentionally frozen (fork principle) —
  toolchain/packaging changes are in scope, algorithm changes are not unless
  explicitly requested.
