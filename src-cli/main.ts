import * as canvas from "canvas";
import { createHash } from "crypto";
import * as fs from "fs";
import minimist from "minimist";
import * as path from "path";
import * as process from "process";
import sharp from "sharp";
import { Catalog, applyCatalogToSettings, catalogBySku, parseCatalog } from "../src/catalog";
import { ColorReducer, SnapMeta } from "../src/colorreductionmanagement";
import { RGB } from "../src/common";
import { FacetBorderSegmenter } from "../src/facetBorderSegmenter";
import { FacetBorderTracer } from "../src/facetBorderTracer";
import { FacetCreator } from "../src/facetCreator";
import { FacetLabelPlacer } from "../src/facetLabelPlacer";
import { FacetResult } from "../src/facetmanagement";
import { FacetReducer } from "../src/facetReducer";
import { buildKitPdf, LegendRow } from "./kitpdf";
import { Settings } from "../src/settings";
import { Point } from "../src/structs/point";

class CLISettingsOutputProfile {
    public name: string = "";
    public svgShowLabels: boolean = true;
    public svgFillFacets: boolean = true;
    public svgShowBorders: boolean = true;
    public svgSizeMultiplier: number = 3;

    public svgFontSize: number = 60;
    public svgFontColor: string = "black";

    public filetype: "svg" | "png" | "jpg" = "svg";
    public filetypeQuality: number = 95;
}

class CLISettings extends Settings {

    public outputProfiles: CLISettingsOutputProfile[] = [];

}

// Resolved, validated options shared by single-image and batch runs. Parsed
// once up front so a batch reuses one settings + catalog object across images.
interface KitOptions {
    settings: CLISettings;
    catalog: Catalog | null;
    canvasWidthCm: number;
    canvasHeightCm: number;
    coverageConst: number;
    dpi: number;
    paper: { wCm: number; hCm: number };
    paperName: string;
    // Batch silences the per-stage progress chatter (one line per image only).
    quiet: boolean;
}

interface ColorBOMEntry {
    number: number;
    sku: string;
    name: string;
    hex: string;
    areaPercentage: number;
    tubes: number;
}

interface KitResult {
    // sha256 over the deterministic kit artifacts (palette JSON + shopping
    // list + numbered canvas SVG). The spike proved these are byte-identical
    // across runs in the same environment; the PDF is deliberately excluded
    // (pdfkit embeds a timestamp/file-id, so it is visually-equivalent only).
    sha256: string;
    // null when not in kit mode (no --catalog).
    colorBOM: ColorBOMEntry[] | null;
}

const PAPERS: { [k: string]: { wCm: number; hCm: number } } = {
    a4: { wCm: 21.0, hCm: 29.7 },
    letter: { wCm: 21.59, hCm: 27.94 },
};

function parseKitOptions(args: minimist.ParsedArgs): KitOptions {
    let configPath = args.c;
    if (typeof configPath === "undefined") {
        configPath = path.join(process.cwd(), "settings.json");
    } else {
        if (!path.isAbsolute(configPath)) {
            configPath = path.join(process.cwd(), configPath);
        }
    }

    // Parse settings as plain JSON rather than require()-ing it, so a
    // settings file can never execute arbitrary code. Merge onto a real
    // CLISettings instance so missing keys fall back to defaults rather than
    // being undefined (a raw cast left partial configs behaving unpredictably).
    const fileSettings = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<CLISettings>;
    const settings: CLISettings = Object.assign(new CLISettings(), fileSettings);

    // A value-flag given without a parseable value (e.g. `--coverage -1`, where
    // minimist eats the negative as a flag) arrives as boolean `true`. Reject
    // it explicitly — otherwise Number(true)===1 would silently slip through.
    const requireValue = (name: string, val: unknown) => {
        if (typeof val === "boolean") {
            console.error(`--${name} requires a value (use --${name}=VALUE for negatives)`);
            process.exit(1);
        }
    };

    // Kit mode: snap generated colors to a real paint catalog.
    let catalog: Catalog | null = null;
    if (typeof args.catalog !== "undefined") {
        requireValue("catalog", args.catalog);
        let catalogPath: string = String(args.catalog);
        if (!path.isAbsolute(catalogPath)) {
            catalogPath = path.join(process.cwd(), catalogPath);
        }
        catalog = parseCatalog(fs.readFileSync(catalogPath, "utf-8"));
        applyCatalogToSettings(settings, catalog);
        console.log(`Using catalog "${catalog.name}" (${catalog.colors.length} colors)`);
    }

    // Painting complexity is decoupled from catalog size: --colors drives the
    // cluster count; the catalog only controls the post-snap target set.
    if (typeof args.colors !== "undefined") {
        requireValue("colors", args.colors);
        const n = Number(args.colors);
        // Upper bound: k-means allocates/iterates k centroids per unique color;
        // an unbounded --colors is a trivial CPU/memory kill, and a kit with
        // hundreds of paint numbers is unpaintable anyway.
        const MAX_COLORS = 256;
        if (!Number.isInteger(n) || n < 1 || n > MAX_COLORS) {
            console.error(`--colors must be an integer 1-${MAX_COLORS}, got "${args.colors}"`);
            process.exit(1);
        }
        settings.kMeansNrOfClusters = n;
    }

    // Physical canvas size (cm) — drives the tube-count estimate and the
    // print PDF. Format "WxH", default A2-ish 40x50.
    let canvasWidthCm = 40;
    let canvasHeightCm = 50;
    if (typeof args["canvas-size"] !== "undefined") {
        requireValue("canvas-size", args["canvas-size"]);
        const m = String(args["canvas-size"]).match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
        if (!m) {
            console.error(`--canvas-size must be "WxH" in cm, got "${args["canvas-size"]}"`);
            process.exit(1);
        }
        canvasWidthCm = Number(m[1]);
        canvasHeightCm = Number(m[2]);
        // 0x0 would silently floor every tube to 1; an absurd size overflows.
        if (canvasWidthCm <= 0 || canvasHeightCm <= 0 || canvasWidthCm > 1000 || canvasHeightCm > 1000) {
            console.error(`--canvas-size dimensions must be between 0 and 1000 cm, got "${args["canvas-size"]}"`);
            process.exit(1);
        }
    }

    // Tubes per cm² of painted area. This is a rough ESTIMATE (thin acrylic
    // layer, one coat); overridable with --coverage. Tuning it against a real
    // painted canvas is an explicit open question in the design doc.
    let coverageConst = 0.0025; // ~1 tube per 400 cm²
    if (typeof args.coverage !== "undefined") {
        requireValue("coverage", args.coverage);
        const cov = Number(args.coverage);
        if (!Number.isFinite(cov) || cov <= 0) {
            console.error(`--coverage must be a positive number, got "${args.coverage}"`);
            process.exit(1);
        }
        coverageConst = cov;
    }

    // Print resolution for the kit PDF's rasterized cover preview, and the
    // coarse-printer floor of the legibility guard. Vector pages don't depend
    // on it; only the cover raster and the min-feature check do.
    let dpi = 300;
    if (typeof args.dpi !== "undefined") {
        requireValue("dpi", args.dpi);
        const d = Number(args.dpi);
        if (!Number.isInteger(d) || d < 72 || d > 1200) {
            console.error(`--dpi must be an integer 72-1200, got "${args.dpi}"`);
            process.exit(1);
        }
        dpi = d;
    }

    let paperName = "A4";
    if (typeof args.paper !== "undefined") {
        requireValue("paper", args.paper);
        paperName = String(args.paper);
        if (!PAPERS[paperName.toLowerCase()]) {
            console.error(`--paper must be one of ${Object.keys(PAPERS).map((p) => p.toUpperCase()).join(", ")}, got "${args.paper}"`);
            process.exit(1);
        }
    }

    return {
        settings,
        catalog,
        canvasWidthCm,
        canvasHeightCm,
        coverageConst,
        dpi,
        paper: PAPERS[paperName.toLowerCase()],
        paperName,
        quiet: false,
    };
}

async function generateKit(imagePath: string, svgPath: string, opts: KitOptions): Promise<KitResult> {
    const { settings, catalog, canvasWidthCm, canvasHeightCm, coverageConst, dpi, paper, paperName } = opts;
    const canvasAreaCm2 = canvasWidthCm * canvasHeightCm;
    const log = opts.quiet ? (_m: string) => { /* batch: per-image line only */ } : (m: string) => console.log(m);

    // Holders for the deterministic artifacts hashed into the manifest.
    let kitCsv = "";
    let kitCanvasSvg = "";
    let kitColorBOM: ColorBOMEntry[] | null = null;

    const img = await canvas.loadImage(imagePath);
    const c = canvas.createCanvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let imgData = ctx.getImageData(0, 0, c.width, c.height);

    // resize if required
    if (settings.resizeImageIfTooLarge && (c.width > settings.resizeImageWidth || c.height > settings.resizeImageHeight)) {
        let width = c.width;
        let height = c.height;
        if (width > settings.resizeImageWidth) {
            const newWidth = settings.resizeImageWidth;
            const newHeight = c.height / c.width * settings.resizeImageWidth;
            width = newWidth;
            height = newHeight;
        }
        if (height > settings.resizeImageHeight) {
            const newHeight = settings.resizeImageHeight;
            const newWidth = width / height * newHeight;
            width = newWidth;
            height = newHeight;
        }

        const tempCanvas = canvas.createCanvas(width, height);
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCanvas.getContext("2d")!.drawImage(c, 0, 0, width, height);
        c.width = width;
        c.height = height;
        ctx.drawImage(tempCanvas, 0, 0, width, height);
        imgData = ctx.getImageData(0, 0, c.width, c.height);

        log(`Resized image to ${width}x${height}`);
    }

    log("Running k-means clustering");
    const cKmeans = canvas.createCanvas(imgData.width, imgData.height);
    const ctxKmeans = cKmeans.getContext("2d")!;
    ctxKmeans.fillStyle = "white";
    ctxKmeans.fillRect(0, 0, cKmeans.width, cKmeans.height);

    const kmeansImgData = ctxKmeans.getImageData(0, 0, cKmeans.width, cKmeans.height);
    // node-canvas ImageData is structurally compatible but lacks the DOM-only
    // `colorSpace` field; bridge the two typings explicitly.
    const domImgData = imgData as unknown as ImageData;
    const domKmeansImgData = kmeansImgData as unknown as ImageData;
    const domCtx = ctx as unknown as CanvasRenderingContext2D;
    const snapMeta: SnapMeta | null = catalog !== null ? new Map() : null;
    await ColorReducer.applyKMeansClustering(domImgData, domKmeansImgData, domCtx, settings, (kmeans) => {
        const progress = (100 - (kmeans.currentDeltaDistanceDifference > 100 ? 100 : kmeans.currentDeltaDistanceDifference)) / 100;
        ctxKmeans.putImageData(kmeansImgData, 0, 0);
    }, snapMeta);

    const colormapResult = ColorReducer.createColorMap(domKmeansImgData);

    let facetResult = new FacetResult();
    if (typeof settings.narrowPixelStripCleanupRuns === "undefined" || settings.narrowPixelStripCleanupRuns === 0) {
        log("Creating facets");
        facetResult = await FacetCreator.getFacets(imgData.width, imgData.height, colormapResult.imgColorIndices, (progress) => {
            // progress
        });

        log("Reducing facets");
        await FacetReducer.reduceFacets(settings.removeFacetsSmallerThanNrOfPoints, settings.removeFacetsFromLargeToSmall, settings.maximumNumberOfFacets, colormapResult.colorsByIndex, facetResult, colormapResult.imgColorIndices, (progress) => {
            // progress
        });
    } else {
        for (let run = 0; run < settings.narrowPixelStripCleanupRuns; run++) {
            log("Removing narrow pixels run #" + (run + 1));
            // clean up narrow pixel strips
            await ColorReducer.processNarrowPixelStripCleanup(colormapResult);

            log("Creating facets");
            facetResult = await FacetCreator.getFacets(imgData.width, imgData.height, colormapResult.imgColorIndices, (progress) => {
                // progress
            });

            log("Reducing facets");
            await FacetReducer.reduceFacets(settings.removeFacetsSmallerThanNrOfPoints, settings.removeFacetsFromLargeToSmall, settings.maximumNumberOfFacets, colormapResult.colorsByIndex, facetResult, colormapResult.imgColorIndices, (progress) => {
                // progress
            });

            // the colormapResult.imgColorIndices get updated as the facets are reduced, so just do a few runs of pixel cleanup
        }
    }

    log("Build border paths");
    await FacetBorderTracer.buildFacetBorderPaths(facetResult, (progress) => {
        // progress
    });

    log("Build border path segments");
    await FacetBorderSegmenter.buildFacetBorderSegments(facetResult, settings.nrOfTimesToHalveBorderSegments, (progress) => {
        // progress
    });

    log("Determine label placement");
    await FacetLabelPlacer.buildFacetLabelBounds(facetResult, (progress) => {
        // progress
    });

    // Per-color pixel frequency. Drives phantom filtering, the 1..N renumber,
    // and area%. Computed before output so the renumber can label the SVG.
    const colorFrequency: number[] = colormapResult.colorsByIndex.map(() => 0);
    for (const facet of facetResult.facets) {
        if (facet !== null) {
            colorFrequency[facet.color] += facet.pointCount;
        }
    }

    // Kit mode: stable remap raw color index -> 1..N over colors actually used
    // (frequency > 0). Phantom colors (a centroid snapped to a paint whose
    // facets were all removed) get no number and never reach the shopping
    // list. Sorted by raw index so numbering is deterministic and the SAME map
    // drives canvas labels, palette JSON and the shopping list.
    const labelMap: Map<number, number> | null = catalog !== null ? new Map() : null;
    if (labelMap !== null) {
        colorFrequency
            .map((f, i) => ({ f, i }))
            .filter((x) => x.f > 0)
            .map((x) => x.i)
            .sort((a, b) => a - b)
            .forEach((rawIndex, pos) => labelMap.set(rawIndex, pos + 1));
    }

    for (const profile of settings.outputProfiles) {
        log("Generating output for " + profile.name);

        if (typeof profile.filetype === "undefined") {
            profile.filetype = "svg";
        }

        const svgProfilePath = path.join(path.dirname(svgPath), path.basename(svgPath).substr(0, path.basename(svgPath).length - path.extname(svgPath).length) + "-" + profile.name) + "." + profile.filetype;
        const svgString = await createSVG(facetResult, colormapResult.colorsByIndex, profile.svgSizeMultiplier, profile.svgFillFacets, profile.svgShowBorders, profile.svgShowLabels, profile.svgFontSize, profile.svgFontColor, null, labelMap);

        if (profile.filetype === "svg") {
            fs.writeFileSync(svgProfilePath, svgString);
        } else if (profile.filetype === "png") {
            const imageBuffer = await sharp(Buffer.from(svgString)).png().toBuffer();
            fs.writeFileSync(svgProfilePath, imageBuffer);
        } else if (profile.filetype === "jpg") {
            const imageBuffer = await sharp(Buffer.from(svgString))
                .jpeg({ quality: profile.filetypeQuality })
                .toBuffer();
            fs.writeFileSync(svgProfilePath, imageBuffer);
        }
    }

    log("Generating palette info");
    const palettePath = path.join(path.dirname(svgPath), path.basename(svgPath).substr(0, path.basename(svgPath).length - path.extname(svgPath).length) + ".json");

    const colorAliasesByColor: { [key: string]: string } = {};
    for (const alias of Object.keys(settings.colorAliases)) {
        colorAliasesByColor[settings.colorAliases[alias].join(",")] = alias;
    }

    // Initial value 0 guards the empty-array case (reduce with no initial
    // value throws on []); the totalFrequency check below guards divide-by-zero.
    const totalFrequency = colorFrequency.reduce((sum, val) => sum + val, 0);

    // A snapped color is "out of gamut" when its worst-case match (largest
    // CIE76 Lab distance of any cluster that snapped to it) exceeds this ΔE.
    // Starting value, to be tuned against real photos vs real catalogs.
    const OUT_OF_GAMUT_DELTA_E = 10;
    const skuLookup = catalog !== null ? catalogBySku(catalog) : null;
    const outOfGamutSkus: string[] = [];

    // snapMeta is keyed by the snapped RGB string. Resolve a color to its
    // catalog entry by SKU (the non-lossy path) — shared by the palette JSON
    // and the shopping list so the two can't drift out of sync.
    const resolveCatalogEntry = (rgb: RGB) => {
        if (snapMeta === null || skuLookup === null) return null;
        const meta = snapMeta.get(rgb.join(","));
        if (!meta || meta.sku === null) return null;
        return { sku: meta.sku, cat: skuLookup.get(meta.sku), distance: meta.distance };
    };

    // Catalog name/sku are user-supplied strings rendered into CSV/Markdown
    // deliverables. Neutralize structural and formula-injection payloads.
    const csvCell = (s: string) => {
        let v = String(s).replace(/[\r\n]+/g, " ");
        if (/^[=+\-@\t]/.test(v)) v = "'" + v; // defang spreadsheet formulas
        return `"${v.replace(/"/g, '""')}"`;
    };
    const mdCell = (s: string) =>
        String(s).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");

    const paletteInfo = JSON.stringify(colormapResult.colorsByIndex.map((color, index) => {
        const entry: {
            areaPercentage: number;
            color: RGB;
            colorAlias: string | undefined;
            frequency: number;
            index: number;
            number?: number;
            sku?: string;
            name?: string;
            snapDistance?: number;
            outOfGamut?: boolean;
        } = {
            areaPercentage: totalFrequency === 0 ? 0 : colorFrequency[index] / totalFrequency,
            color,
            colorAlias: colorAliasesByColor[color.join(",")],
            frequency: colorFrequency[index],
            index,
        };

        // The kit's human-facing 1..N number (same map as canvas labels).
        if (labelMap !== null && labelMap.has(index)) {
            entry.number = labelMap.get(index);
        }

        // Catalog enrichment is keyed by sku via snapMeta — NOT by reverse
        // RGB lookup (duplicate catalog RGBs are rejected at parse time).
        if (catalog !== null) {
            const r = resolveCatalogEntry(color);
            if (r) {
                entry.sku = r.sku;
                entry.name = r.cat ? r.cat.name : undefined;
                // colorAlias is reused as the sku to keep the palette JSON
                // schema stable for existing consumers (the field name
                // predates kit mode); `sku` is also emitted explicitly.
                entry.colorAlias = r.sku;
                entry.snapDistance = r.distance;
                entry.outOfGamut = r.distance > OUT_OF_GAMUT_DELTA_E;
                if (entry.outOfGamut && colorFrequency[index] > 0) {
                    outOfGamutSkus.push(r.sku);
                }
            }
        }
        return entry;
    }), null, 2);

    if (outOfGamutSkus.length > 0) {
        log(`Warning: ${outOfGamutSkus.length} color(s) are a poor catalog match ` +
            `(ΔE > ${OUT_OF_GAMUT_DELTA_E}): ${outOfGamutSkus.join(", ")}. ` +
            `The kit still generates; consider a richer catalog.`);
    }

    fs.writeFileSync(palettePath, paletteInfo);

    // Shopping list (kit mode only). One row per paint actually used, numbered
    // by the same 1..N map as the canvas. Phantom colors (frequency 0) are
    // excluded by construction — they have no labelMap entry.
    if (catalog !== null && snapMeta !== null && skuLookup !== null && labelMap !== null) {
        const toHex = (rgb: RGB) =>
            "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

        const rows = colormapResult.colorsByIndex
            .map((color, index) => ({ color, index }))
            .filter((x) => labelMap.has(x.index) && colorFrequency[x.index] > 0)
            .map((x) => {
                const r = resolveCatalogEntry(x.color);
                const sku = r ? r.sku : "?";
                const cat = r ? r.cat : undefined;
                const areaPct = totalFrequency === 0 ? 0 : colorFrequency[x.index] / totalFrequency;
                const tubes = Math.max(1, Math.ceil(areaPct * canvasAreaCm2 * coverageConst));
                return {
                    number: labelMap.get(x.index)!,
                    sku,
                    name: cat ? cat.name : "(unknown)",
                    hex: toHex(cat ? cat.rgb : x.color),
                    areaPct,
                    tubes,
                };
            })
            .sort((a, b) => a.number - b.number);

        const base = path.join(
            path.dirname(svgPath),
            path.basename(svgPath, path.extname(svgPath)),
        );

        const csv = ["number,sku,name,hex,areaPercentage,tubes"]
            .concat(rows.map((r) =>
                `${r.number},${csvCell(r.sku)},${csvCell(r.name)},${r.hex},${r.areaPct.toFixed(6)},${r.tubes}`))
            .join("\n") + "\n";
        fs.writeFileSync(base + "-shopping-list.csv", csv);

        const md = [
            `# Shopping list — ${mdCell(catalog.name)}`,
            "",
            `Canvas ${canvasWidthCm}x${canvasHeightCm} cm. Tube counts are a rough estimate ` +
            `(coverage ${coverageConst} tubes/cm², override with \`--coverage\`).`,
            "",
            "| # | SKU | Paint | Swatch | Area % | Tubes |",
            "| --- | --- | --- | --- | ---: | ---: |",
        ].concat(rows.map((r) =>
            `| ${r.number} | ${mdCell(r.sku)} | ${mdCell(r.name)} | \`${r.hex}\` | ${(r.areaPct * 100).toFixed(1)}% | ${r.tubes} |`))
            .join("\n") + "\n";
        fs.writeFileSync(base + "-shopping-list.md", md);

        kitCsv = csv;
        kitColorBOM = rows.map((r) => ({
            number: r.number,
            sku: r.sku,
            name: r.name,
            hex: r.hex,
            areaPercentage: r.areaPct,
            tubes: r.tubes,
        }));

        log(`Shopping list: ${rows.length} paints -> ${base}-shopping-list.{csv,md}`);

        // ---- Print-ready kit PDF (step 4) --------------------------------
        // Legibility guard: a hand-painted number needs ~4 mm; the printer
        // also can't reproduce a feature finer than one dot. The guard floor
        // is the larger of the two, converted to image pixels so createSVG
        // (which sees labelBounds in image-pixel space) can apply it.
        const MIN_LABEL_MM = 4;
        const imgPxPerCm = facetResult.width / canvasWidthCm;
        const printerDotCm = 2.54 / dpi;
        const minFeatureCm = Math.max(MIN_LABEL_MM / 10, printerDotCm);
        const minLabelPx = minFeatureCm * imgPxPerCm;

        // Numbered canvas: borders + guarded labels, no fill (paint-by-swatch
        // regions stay outlined even where the number is suppressed).
        const canvasSvg = await createSVG(facetResult, colormapResult.colorsByIndex,
            3, false, true, true, 60, "#000", null, labelMap, minLabelPx);
        fs.writeFileSync(base + "-canvas.svg", canvasSvg);
        kitCanvasSvg = canvasSvg;

        // Colored cover preview (filled, no borders/labels), rasterized.
        const coverSvg = await createSVG(facetResult, colormapResult.colorsByIndex,
            3, true, false, false, 60, "#000", null, labelMap);
        const coverPng = await sharp(Buffer.from(coverSvg))
            .resize({ width: Math.min(3 * facetResult.width, 2000), withoutEnlargement: true })
            .png().toBuffer();
        fs.writeFileSync(base + "-cover.png", coverPng);

        const legend: LegendRow[] = rows.map((r) => ({
            number: r.number, sku: r.sku, name: r.name, hex: r.hex,
        }));

        const pdfPath = base + "-kit.pdf";
        const kit = await buildKitPdf({
            outPath: pdfPath,
            canvasSvg,
            coverPng,
            legend,
            catalogName: catalog.name,
            canvasWidthCm,
            canvasHeightCm,
            paperWidthCm: paper.wCm,
            paperHeightCm: paper.hCm,
        });
        log(`Kit PDF: ${kit.pages} pages (${kit.cols}x${kit.rows} canvas tiles on ${paperName}) -> ${pdfPath}`);
    }

    // Hash only the proven-deterministic artifacts (see KitResult). Empty
    // strings in non-kit mode still hash stably; colorBOM stays null there.
    const sha256 = createHash("sha256")
        .update(paletteInfo).update(kitCsv).update(kitCanvasSvg)
        .digest("hex");
    return { sha256, colorBOM: kitColorBOM };
}

// `minLabelPx` is the print-legibility guard (kit mode): a facet whose label
// box is smaller than this many image pixels in either dimension is too small
// to carry a readable hand-painted number at the chosen physical canvas size,
// so its in-facet number is suppressed (the region keeps its fill/border and
// is recovered from the swatch legend). This is print-space and distinct from
// the pixel-space `removeFacetsSmallerThanNrOfPoints` facet removal. 0 = off.
async function createSVG(facetResult: FacetResult, colorsByIndex: RGB[], sizeMultiplier: number, fill: boolean, stroke: boolean, addColorLabels: boolean, fontSize: number = 60, fontColor: string = "black", onUpdate: ((progress: number) => void) | null = null, labelMap: Map<number, number> | null = null, minLabelPx: number = 0) {

    let svgString = "";
    const xmlns = "http://www.w3.org/2000/svg";

    const svgWidth = sizeMultiplier * facetResult.width;
    const svgHeight = sizeMultiplier * facetResult.height;
    // A `viewBox` is required for the PDF step: svg-to-pdfkit scales by the
    // viewBox, and the kit canvas must map to a real physical size. The legacy
    // SVG had none (pixel dims only); adding it is backward-compatible.
    svgString += `<?xml version="1.0" standalone="no"?>
                  <svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="${xmlns}">`;

    for (const f of facetResult.facets) {

        if (f != null && f.borderSegments.length > 0) {
            let newpath: Point[] = [];
            const useSegments = true;
            if (useSegments) {
                newpath = f.getFullPathFromBorderSegments(false);
            } else {
                for (let i: number = 0; i < f.borderPath.length; i++) {
                    newpath.push(new Point(f.borderPath[i].getWallX() + 0.5, f.borderPath[i].getWallY() + 0.5));
                }
            }
            if (newpath[0].x !== newpath[newpath.length - 1].x || newpath[0].y !== newpath[newpath.length - 1].y) {
                newpath.push(newpath[0]);
            } // close loop if necessary

            // Create a path in SVG's namespace
            // using quadratic curve absolute positions

            let svgPathString = "";

            let data = "M ";
            data += newpath[0].x * sizeMultiplier + " " + newpath[0].y * sizeMultiplier + " ";
            for (let i: number = 1; i < newpath.length; i++) {
                const midpointX = (newpath[i].x + newpath[i - 1].x) / 2;
                const midpointY = (newpath[i].y + newpath[i - 1].y) / 2;
                data += "Q " + (midpointX * sizeMultiplier) + " " + (midpointY * sizeMultiplier) + " " + (newpath[i].x * sizeMultiplier) + " " + (newpath[i].y * sizeMultiplier) + " ";
            }

            let svgStroke = "";
            if (stroke) {
                svgStroke = "#000";
            } else {
                // make the border the same color as the fill color if there is no border stroke
                // to not have gaps in between facets
                if (fill) {
                    svgStroke = `rgb(${colorsByIndex[f.color][0]},${colorsByIndex[f.color][1]},${colorsByIndex[f.color][2]})`;
                }
            }

            let svgFill = "";
            if (fill) {
                svgFill = `rgb(${colorsByIndex[f.color][0]},${colorsByIndex[f.color][1]},${colorsByIndex[f.color][2]})`;
            } else {
                svgFill = "none";
            }

            svgPathString = `<path data-facetId="${f.id}" d="${data}" `;

            svgPathString += `style="`;
            svgPathString += `fill: ${svgFill};`;
            if (svgStroke !== "") {
                svgPathString += `stroke: ${svgStroke}; stroke-width:1px`;
            }
            svgPathString += `"`;

            svgPathString += `>`;

            svgPathString += `</path>`;

            svgString += svgPathString;

            // add the color labels if necessary. I mean, this is the whole idea behind the paint by numbers part
            // so I don't know why you would hide them
            if (addColorLabels &&
                !(minLabelPx > 0 && Math.min(f.labelBounds.width, f.labelBounds.height) < minLabelPx)) {

                const labelOffsetX = f.labelBounds.minX * sizeMultiplier;
                const labelOffsetY = f.labelBounds.minY * sizeMultiplier;
                const labelWidth = f.labelBounds.width * sizeMultiplier;
                const labelHeight = f.labelBounds.height * sizeMultiplier;

                //     const svgLabelString = `<g class="label" transform="translate(${labelOffsetX},${labelOffsetY})">
                //     <svg width="${labelWidth}" height="${labelHeight}" overflow="visible" viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid meet">
                //         <rect xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="rgb(255,255,255,0.5)" x="-50" y="-50"/>
                //         <text font-family="Tahoma" font-size="60" dominant-baseline="middle" text-anchor="middle">${f.color}</text>
                //     </svg>
                //    </g>`;

                // Kit mode renders the human-facing 1..N number; otherwise the
                // raw zero-based color index (unchanged legacy behavior).
                const labelText = labelMap !== null && labelMap.has(f.color)
                    ? labelMap.get(f.color)!
                    : f.color;
                const nrOfDigits = (labelText + "").length;
                const svgLabelString = `<g class="label" transform="translate(${labelOffsetX},${labelOffsetY})">
                                        <svg width="${labelWidth}" height="${labelHeight}" overflow="visible" viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid meet">
                                            <text font-family="Tahoma" font-size="${(fontSize / nrOfDigits)}" dominant-baseline="middle" text-anchor="middle" fill="${fontColor}">${labelText}</text>
                                        </svg>
                                       </g>`;

                svgString += svgLabelString;
            }
        }
    }

    svgString += `</svg>`;

    return svgString;
}

// Image extensions node-canvas can decode. Anything else in a batch folder
// (including the manifest of a previous run) is skipped, not an error.
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp"]);

interface ManifestImageOk {
    file: string;
    status: "ok";
    sha256: string;
    colorBOM: ColorBOMEntry[] | null;
}
interface ManifestImageError {
    file: string;
    status: "error";
    error: string;
}

async function runBatch(args: minimist.ParsedArgs): Promise<void> {
    let inputDir = args._[1];
    let outputDir = args._[2];
    if (typeof inputDir !== "string" || typeof outputDir !== "string") {
        console.error("Usage: kit-batch <input-dir> <output-dir> [-c <settings_json>]");
        console.error("  --catalog <catalog_json> is required (kit-batch produces paint kits)");
        console.error("  [--colors N] [--canvas-size WxH] [--paper A4|Letter] [--dpi N] [--coverage n]");
        process.exit(1);
    }
    if (!path.isAbsolute(inputDir)) inputDir = path.join(process.cwd(), inputDir);
    if (!path.isAbsolute(outputDir)) outputDir = path.join(process.cwd(), outputDir);

    const opts = parseKitOptions(args);
    if (opts.catalog === null) {
        console.error("kit-batch requires --catalog (it produces paint kits, not bare SVGs)");
        process.exit(1);
    }

    if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
        console.error(`input dir not found: ${inputDir}`);
        process.exit(1);
    }

    // Sorted filename order → deterministic processing AND a deterministic
    // manifest (entries are appended in this order).
    const files = fs.readdirSync(inputDir, { withFileTypes: true })
        .filter((d) => d.isFile() && IMAGE_EXTS.has(path.extname(d.name).toLowerCase()))
        .map((d) => d.name)
        .sort();
    if (files.length === 0) {
        console.error(`no images (${[...IMAGE_EXTS].join(", ")}) in ${inputDir}`);
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const images: (ManifestImageOk | ManifestImageError)[] = [];
    let ok = 0;
    let failed = 0;
    const batchOpts: KitOptions = { ...opts, quiet: true };

    // Stream: process one image → write its kit folder → append a compact
    // manifest entry → drop per-image data (it goes out of scope each
    // iteration), so memory stays bounded over an arbitrarily large folder.
    // One bad image is recorded and skipped — it must never abort the batch.
    for (const file of files) {
        const baseName = path.basename(file, path.extname(file));
        // The kit folder is keyed by the FULL filename, not the
        // extension-stripped base: `photo.jpg` and `photo.png` are distinct
        // images and must not share `<out>/photo` — otherwise the second
        // overwrites the first, and a later failure's cleanup would delete an
        // already-successful kit while the manifest still reports it ok.
        // readdir entries are single path components, so this is injective and
        // traversal-safe. Inner artifact files keep the clean base name.
        const kitDir = path.join(outputDir, file);
        try {
            fs.mkdirSync(kitDir, { recursive: true });
            const res = await generateKit(
                path.join(inputDir, file),
                path.join(kitDir, baseName + ".svg"),
                batchOpts,
            );
            images.push({ file, status: "ok", sha256: res.sha256, colorBOM: res.colorBOM });
            ok++;
            console.log(`ok    ${file}`);
        } catch (e) {
            // Drop the failed kit's (empty or partial) folder so the output
            // tree only ever contains complete kits; the manifest is the
            // record of the failure.
            fs.rmSync(kitDir, { recursive: true, force: true });
            // First line only: deeper stack/path noise would make the manifest
            // non-deterministic and is not actionable in a batch report.
            const msg = String((e as Error).message ?? e).split("\n")[0];
            images.push({ file, status: "error", error: msg });
            failed++;
            console.log(`FAIL  ${file}: ${msg}`);
        }
    }

    // Fixed key order + filename-sorted entries → byte-identical manifest
    // across runs in the same environment (proven by the determinism spike;
    // the PDF is excluded from the per-image hash for that reason).
    const manifest = {
        generator: "paint-by-numbers-generator",
        catalog: { id: opts.catalog.id, name: opts.catalog.name },
        settings: {
            colors: opts.settings.kMeansNrOfClusters,
            randomSeed: opts.settings.randomSeed,
            canvasSizeCm: [opts.canvasWidthCm, opts.canvasHeightCm],
            coveragePerCm2: opts.coverageConst,
            paper: opts.paperName,
            dpi: opts.dpi,
        },
        counts: { total: files.length, ok, failed },
        images,
    };
    const manifestPath = path.join(outputDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nkit-batch: ${ok} ok, ${failed} failed -> ${manifestPath}`);
    // Exit 0 even with failures: a partial batch with a recorded error is a
    // success of the batch runner (the iron isolation rule).
}

async function main(): Promise<void> {
    const args = minimist(process.argv.slice(2));

    if (args._[0] === "kit-batch") {
        return runBatch(args);
    }

    const imagePath = args.i;
    const svgPath = args.o;
    if (typeof imagePath === "undefined" || typeof svgPath === "undefined") {
        console.log("Usage: exe -i <input_image> -o <output_svg> [-c <settings_json>]");
        console.log("  [--catalog <catalog_json>]  snap colors to a real paint catalog");
        console.log("  [--colors <N>]              number of paint regions (painting complexity)");
        console.log("  [--canvas-size <WxH>]       physical canvas size in cm (default 40x50)");
        console.log("  [--paper <A4|Letter>]       print paper for the kit PDF (default A4)");
        console.log("  [--dpi <N>]                 print resolution for the kit PDF (default 300)");
        console.log("  [--coverage <n>]            paint tubes per cm^2 estimate (default 0.0025)");
        console.log("");
        console.log("Batch: exe kit-batch <input-dir> <output-dir> --catalog <catalog_json> [flags]");
        process.exit(1);
    }

    const opts = parseKitOptions(args);
    await generateKit(imagePath, svgPath, opts);
}

main().then(() => {
    console.log("Finished");
}).catch((err) => {
    // Surface the message clearly and exit non-zero so callers (CI, scripts,
    // future kit-batch) can detect failure. Without this the process exited 0
    // on any error, including a malformed catalog.
    console.error("Error: " + err.message);
    process.exit(1);
});
