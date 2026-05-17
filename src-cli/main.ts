import * as canvas from "canvas";
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

async function main() {
    const args = minimist(process.argv.slice(2));
    const imagePath = args.i;
    const svgPath = args.o;

    if (typeof imagePath === "undefined" || typeof svgPath === "undefined") {
        console.log("Usage: exe -i <input_image> -o <output_svg> [-c <settings_json>]");
        console.log("  [--catalog <catalog_json>]  snap colors to a real paint catalog");
        console.log("  [--colors <N>]              number of paint regions (painting complexity)");
        process.exit(1);
    }

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

    // Physical canvas size (cm) — drives the tube-count estimate now, and the
    // print PDF in step 4. Format "WxH", default A2-ish 40x50.
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
    const canvasAreaCm2 = canvasWidthCm * canvasHeightCm;

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

        console.log(`Resized image to ${width}x${height}`);
    }

    console.log("Running k-means clustering");
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
        console.log("Creating facets");
        facetResult = await FacetCreator.getFacets(imgData.width, imgData.height, colormapResult.imgColorIndices, (progress) => {
            // progress
        });

        console.log("Reducing facets");
        await FacetReducer.reduceFacets(settings.removeFacetsSmallerThanNrOfPoints, settings.removeFacetsFromLargeToSmall, settings.maximumNumberOfFacets, colormapResult.colorsByIndex, facetResult, colormapResult.imgColorIndices, (progress) => {
            // progress
        });
    } else {
        for (let run = 0; run < settings.narrowPixelStripCleanupRuns; run++) {
            console.log("Removing narrow pixels run #" + (run + 1));
            // clean up narrow pixel strips
            await ColorReducer.processNarrowPixelStripCleanup(colormapResult);

            console.log("Creating facets");
            facetResult = await FacetCreator.getFacets(imgData.width, imgData.height, colormapResult.imgColorIndices, (progress) => {
                // progress
            });

            console.log("Reducing facets");
            await FacetReducer.reduceFacets(settings.removeFacetsSmallerThanNrOfPoints, settings.removeFacetsFromLargeToSmall, settings.maximumNumberOfFacets, colormapResult.colorsByIndex, facetResult, colormapResult.imgColorIndices, (progress) => {
                // progress
            });

            // the colormapResult.imgColorIndices get updated as the facets are reduced, so just do a few runs of pixel cleanup
        }
    }

    console.log("Build border paths");
    await FacetBorderTracer.buildFacetBorderPaths(facetResult, (progress) => {
        // progress
    });

    console.log("Build border path segments");
    await FacetBorderSegmenter.buildFacetBorderSegments(facetResult, settings.nrOfTimesToHalveBorderSegments, (progress) => {
        // progress
    });

    console.log("Determine label placement");
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
        console.log("Generating output for " + profile.name);

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

    console.log("Generating palette info");
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
        console.warn(`Warning: ${outOfGamutSkus.length} color(s) are a poor catalog match ` +
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

        console.log(`Shopping list: ${rows.length} paints -> ${base}-shopping-list.{csv,md}`);
    }
}

async function createSVG(facetResult: FacetResult, colorsByIndex: RGB[], sizeMultiplier: number, fill: boolean, stroke: boolean, addColorLabels: boolean, fontSize: number = 60, fontColor: string = "black", onUpdate: ((progress: number) => void) | null = null, labelMap: Map<number, number> | null = null) {

    let svgString = "";
    const xmlns = "http://www.w3.org/2000/svg";

    const svgWidth = sizeMultiplier * facetResult.width;
    const svgHeight = sizeMultiplier * facetResult.height;
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
            if (addColorLabels) {

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

main().then(() => {
    console.log("Finished");
}).catch((err) => {
    // Surface the message clearly and exit non-zero so callers (CI, scripts,
    // future kit-batch) can detect failure. Without this the process exited 0
    // on any error, including a malformed catalog.
    console.error("Error: " + err.message);
    process.exit(1);
});
