/**
 * Paint catalog: a named set of real, purchasable paints the generated colors
 * are snapped to. The catalog is the source of truth for sku/name metadata —
 * it is kept as an object and looked up by sku, NOT by reverse-mapping RGB
 * (duplicate RGBs in a catalog would collide and lose sku/name otherwise).
 *
 * File format:
 *   {
 *     "id": "generic-acrylic-24",
 *     "name": "Generic 24-colour acrylic set",
 *     "colors": [ { "sku": "BK", "name": "Black", "rgb": [0, 0, 0] }, ... ]
 *   }
 */
import { RGB } from "./common";
import { ClusteringColorSpace, Settings } from "./settings";

export interface CatalogColor {
    sku: string;
    name: string;
    rgb: RGB;
}

export interface Catalog {
    id: string;
    name: string;
    colors: CatalogColor[];
}

/** A paintable kit tops out well below this; the cap also bounds snap cost. */
export const MAX_CATALOG_COLORS = 512;

function fail(msg: string): never {
    throw new Error(`Invalid catalog: ${msg}`);
}

/**
 * Parse + validate a catalog from raw JSON text. Throws a clear Error on any
 * malformed input (the CLI surfaces this and exits non-zero).
 */
export function parseCatalog(jsonText: string): Catalog {
    let raw: unknown;
    try {
        raw = JSON.parse(jsonText);
    } catch (e) {
        fail(`not valid JSON (${(e as Error).message})`);
    }

    if (typeof raw !== "object" || raw === null) fail("must be a JSON object");
    const obj = raw as Record<string, unknown>;

    if (typeof obj.id !== "string" || obj.id.length === 0) fail("`id` must be a non-empty string");
    if (typeof obj.name !== "string" || obj.name.length === 0) fail("`name` must be a non-empty string");
    if (!Array.isArray(obj.colors) || obj.colors.length === 0) fail("`colors` must be a non-empty array");
    // Upper bound: the snap is O(uniqueImageColors * catalogSize) in the hot
    // path, and a paint-by-numbers kit with hundreds of colors is unpaintable
    // anyway. Reject absurd catalogs rather than let them DoS the run.
    if (obj.colors.length > MAX_CATALOG_COLORS) {
        fail(`too many colors (${obj.colors.length}); max is ${MAX_CATALOG_COLORS}`);
    }

    const seenSkus = new Set<string>();
    const seenRgb = new Set<string>();
    const colors: CatalogColor[] = obj.colors.map((c, i) => {
        if (typeof c !== "object" || c === null) fail(`colors[${i}] must be an object`);
        const cc = c as Record<string, unknown>;
        if (typeof cc.sku !== "string" || cc.sku.length === 0) fail(`colors[${i}].sku must be a non-empty string`);
        if (seenSkus.has(cc.sku)) fail(`duplicate sku "${cc.sku}" — skus must be unique`);
        seenSkus.add(cc.sku);
        if (typeof cc.name !== "string" || cc.name.length === 0) fail(`colors[${i}].name must be a non-empty string`);
        const rgb = cc.rgb;
        if (!Array.isArray(rgb) || rgb.length !== 3 ||
            !rgb.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255)) {
            fail(`colors[${i}].rgb must be [r,g,b] with integers 0-255`);
        }
        // The pipeline matches image colors to paints by RGB; two paints with
        // identical RGB are physically indistinguishable to the snap, so one
        // would be silently dropped. Reject, mirroring the duplicate-sku check.
        const rgbKey = `${rgb[0]},${rgb[1]},${rgb[2]}`;
        if (seenRgb.has(rgbKey)) {
            fail(`colors[${i}] ("${cc.sku}") has duplicate rgb [${rgbKey}] — the pipeline cannot distinguish two paints with the same color`);
        }
        seenRgb.add(rgbKey);
        return { sku: cc.sku, name: cc.name, rgb: [rgb[0], rgb[1], rgb[2]] as RGB };
    });

    return { id: obj.id, name: obj.name, colors };
}

/**
 * Wire a catalog into Settings so the existing k-means + post-snap pipeline
 * targets the catalog colors. Kit mode forces LAB clustering AND LAB snapping
 * (default settings cluster in RGB — an explicit, deliberate choice here, since
 * it changes output more than anything downstream).
 *
 * `kMeansNrOfClusters` (painting complexity) is NOT set here — it is driven by
 * the separate `--colors` flag. Catalog size only controls the snap target set.
 */
export function applyCatalogToSettings(settings: Settings, catalog: Catalog): void {
    settings.colorAliases = {};
    for (const c of catalog.colors) {
        settings.colorAliases[c.sku] = c.rgb;
    }
    settings.kMeansColorRestrictions = catalog.colors.map((c) => c.sku);
    settings.kMeansClusteringColorSpace = ClusteringColorSpace.LAB;
}

/** sku -> catalog entry, for non-lossy palette enrichment. */
export function catalogBySku(catalog: Catalog): Map<string, CatalogColor> {
    const m = new Map<string, CatalogColor>();
    for (const c of catalog.colors) m.set(c.sku, c);
    return m;
}
