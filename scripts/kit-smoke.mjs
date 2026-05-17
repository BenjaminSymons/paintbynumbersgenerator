// Kit-pipeline smoke test (Phase 1 steps 1-4 + Phase 2 step 5). Not a
// unit-test framework — a self-contained assertion script in the project's
// existing CLI-smoke style. Generates fixtures in a temp dir, runs
// dist/cli.js, asserts on the outputs, exits non-zero on any failure.
// Checks 15-18 cover step 4 (print-ready PDF, tile-count math, the
// print-legibility guard, paper/dpi validation); 19-20 cover step 6b
// (kit-batch isolation + byte-identical manifest determinism).
//
// Run: node scripts/kit-smoke.mjs   (after `npm run build:cli`)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();
const CLI = path.join(ROOT, "dist", "cli.js");
const TESTINPUT = path.join(ROOT, "src-cli", "testinput.png");
const GENERIC = path.join(ROOT, "src-cli", "catalogs", "generic-acrylic-24.json");
const SETTINGS = path.join(ROOT, "src-cli", "settings.json");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pbn-kit-smoke-"));

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
}
function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}
/** Run the CLI; returns { code, stdout, stderr } (both streams, any exit). */
function run(args) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const csvSkus = (p) => fs.readFileSync(p, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[1]);

// --- Generate image fixtures up front (top-level await, ESM) ---------------
// Phantom fixture: mostly white + a tiny 1px red strip. With a large
// removeFacetsSmallerThanNrOfPoints a centroid snaps to red but its facets
// are removed -> red becomes a frequency:0 phantom.
const PHANTOM_SRC = path.join(work, "phantom-src.png");
{
    const W = 120, H = 120;
    const buf = Buffer.alloc(W * H * 3, 255);
    for (let y = 5; y < 115; y++) {
        const off = (y * W + 100) * 3;
        buf[off] = 200; buf[off + 1] = 30; buf[off + 2] = 30;
    }
    await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(PHANTOM_SRC);
}
const SOLID_SRC = path.join(work, "solid.png");
await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 120, g: 30, b: 30 } } })
    .png().toFile(SOLID_SRC);

// Colorful fixture: saturated R/G/B quadrants + white. Saturated primaries are
// far from BOTH black and white in Lab, so a 2-colour BK/WH catalog must flag
// out-of-gamut (testinput.png is B&W line art and would not).
const COLORFUL_SRC = path.join(work, "colorful.png");
{
    const W = 120, H = 120;
    const buf = Buffer.alloc(W * H * 3, 255);
    const put = (x0, y0, x1, y1, r, g, b) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const o = (y * W + x) * 3; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
        }
    };
    put(0, 0, 60, 60, 220, 20, 20);
    put(60, 0, 120, 60, 20, 180, 40);
    put(0, 60, 60, 120, 30, 60, 200);
    await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(COLORFUL_SRC);
}

// ---- 1. catalog enrich + renumber + tube formula ---------------------------
check("catalog enrich + 1..N renumber + tube formula", () => {
    const o = path.join(work, "k.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "16", "--canvas-size", "40x50", "--coverage", "0.0025"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const pal = J(path.join(work, "k.json"));
    const used = pal.filter((e) => e.frequency > 0);
    assert(used.length > 0, "no used colors");
    for (const e of used) {
        assert(typeof e.sku === "string" && e.sku.length > 0, `used color idx ${e.index} missing sku`);
        assert(typeof e.name === "string" && e.name.length > 0, `sku ${e.sku} missing name`);
    }
    const nums = used.map((e) => e.number).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) {
        assert(nums[i] === i + 1, `numbering not contiguous 1..N: ${nums}`);
    }
    const svg = fs.readFileSync(path.join(work, "k-bordersLabels.svg"), "utf8");
    const labelSet = [...new Set([...svg.matchAll(/>(\d+)<\/text>/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    assert(labelSet.length > 0 && !labelSet.includes(0), `SVG labels must be 1..N, got ${labelSet}`);
    assert(JSON.stringify(labelSet) === JSON.stringify(nums), `SVG labels ${labelSet} != palette numbers ${nums}`);
    for (const row of fs.readFileSync(path.join(work, "k-shopping-list.csv"), "utf8").trim().split("\n").slice(1)) {
        const f = row.split(",");
        const areaPct = Number(f[f.length - 2]);
        const tubes = Number(f[f.length - 1]);
        const expected = Math.max(1, Math.ceil(areaPct * 40 * 50 * 0.0025));
        assert(tubes === expected, `tube count ${tubes} != expected ${expected} for row ${row}`);
    }
    // out-of-gamut consistency (catches "flags everything" / "warns spuriously"):
    // every enriched entry's flag must equal (snapDistance > 10), and the
    // warned skus must be exactly the used+flagged set — not more, not fewer.
    for (const e of pal.filter((x) => "snapDistance" in x)) {
        assert(e.outOfGamut === (e.snapDistance > 10),
            `outOfGamut for ${e.sku} (${e.snapDistance}) must equal snapDistance>10`);
    }
    const flaggedUsed = new Set(pal.filter((e) => e.frequency > 0 && e.outOfGamut === true).map((e) => e.sku));
    const warnMatch = (r.stderr + r.stdout).match(/poor catalog match[^:]*: ([^.]+)\./);
    const warnedSkus = new Set(warnMatch ? warnMatch[1].split(",").map((s) => s.trim()) : []);
    assert(flaggedUsed.size === warnedSkus.size && [...flaggedUsed].every((s) => warnedSkus.has(s)),
        `warned skus ${[...warnedSkus]} must equal used+flagged ${[...flaggedUsed]}`);
});

// ---- 2. no-catalog regression ---------------------------------------------
check("no-catalog regression (legacy output unchanged)", () => {
    const o = path.join(work, "p.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS]);
    assert(r.code === 0, `expected exit 0, got ${r.code}`);
    assert(!fs.existsSync(path.join(work, "p-shopping-list.csv")), "shopping list must NOT exist without --catalog");
    const pal = J(path.join(work, "p.json"));
    assert(!pal.some((e) => "sku" in e), "palette must not carry sku without --catalog");
    assert(!pal.some((e) => "number" in e), "palette must not carry kit number without --catalog");
});

// ---- 3. malformed catalog -> clear error + non-zero exit ------------------
check("malformed catalog -> non-zero exit + clear message", () => {
    const bad = path.join(work, "bad.json");
    fs.writeFileSync(bad, '{"id":"b","name":"b","colors":[{"sku":"A","name":"A","rgb":[0,0]}]}');
    const r = run(["-i", TESTINPUT, "-o", path.join(work, "b.svg"), "-c", SETTINGS, "--catalog", bad]);
    assert(r.code !== 0, `expected non-zero exit, got ${r.code}`);
    assert(/Invalid catalog/.test(r.stderr), `expected "Invalid catalog" in stderr, got: ${r.stderr}`);
});

// ---- 4. CRITICAL: phantom filter (real freq:0 color excluded) -------------
check("CRITICAL phantom filter: freq:0 color excluded, numbering stays contiguous", () => {
    const cat = path.join(work, "cat3.json");
    fs.writeFileSync(cat, JSON.stringify({ id: "c3", name: "c3", colors: [
        { sku: "WH", name: "White", rgb: [255, 255, 255] },
        { sku: "GR", name: "Green", rgb: [40, 150, 70] },
        { sku: "RD", name: "Red", rgb: [200, 30, 30] },
    ] }));
    const stng = path.join(work, "settings-strip.json");
    const base = J(SETTINGS);
    base.removeFacetsSmallerThanNrOfPoints = 400;
    base.narrowPixelStripCleanupRuns = 0;
    fs.writeFileSync(stng, JSON.stringify(base));
    const o = path.join(work, "phx.svg");
    const r = run(["-i", PHANTOM_SRC, "-o", o, "-c", stng, "--catalog", cat, "--colors", "3"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const pal = J(path.join(work, "phx.json"));
    const phantoms = pal.filter((e) => e.frequency === 0);
    assert(phantoms.length > 0, "fixture did not produce a freq:0 phantom — adjust fixture");
    for (const ph of phantoms) {
        assert(ph.number === undefined, `phantom ${ph.sku} must have no kit number, got ${ph.number}`);
    }
    const skus = csvSkus(path.join(work, "phx-shopping-list.csv"));
    for (const ph of phantoms) {
        assert(!skus.includes(ph.sku), `phantom ${ph.sku} must be ABSENT from shopping list, got ${skus}`);
    }
    const nums = pal.filter((e) => e.frequency > 0).map((e) => e.number).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) {
        assert(nums[i] === i + 1, `numbering not contiguous after phantom filter: ${nums}`);
    }
});

// ---- 5. out-of-gamut flagged ----------------------------------------------
check("out-of-gamut flagged + warned", () => {
    const cat = path.join(work, "bw.json");
    fs.writeFileSync(cat, JSON.stringify({ id: "bw", name: "bw", colors: [
        { sku: "BK", name: "Black", rgb: [0, 0, 0] },
        { sku: "WH", name: "White", rgb: [255, 255, 255] },
    ] }));
    const o = path.join(work, "oog.svg");
    const r = run(["-i", COLORFUL_SRC, "-o", o, "-c", SETTINGS, "--catalog", cat, "--colors", "8"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}`);
    const pal = J(path.join(work, "oog.json"));
    assert(pal.some((e) => e.frequency > 0 && e.outOfGamut === true),
        "colorful image vs 2-color catalog must flag outOfGamut");
    assert(/poor catalog match/.test(r.stderr) || /poor catalog match/.test(r.stdout),
        "expected out-of-gamut warning");
});

// ---- 6. REGRESSION: solid single-color image must not crash --------------
check("REGRESSION solid single-color image (reduce/divide-by-zero guard)", () => {
    const o = path.join(work, "solid.svg");
    const r = run(["-i", SOLID_SRC, "-o", o, "-c", SETTINGS]);
    assert(r.code === 0, `expected exit 0 on solid image, got ${r.code}: ${r.stderr}`);
    const pal = J(path.join(work, "solid.json"));
    assert(Array.isArray(pal) && pal.length >= 1, "solid image must still produce a valid palette");
});

// ---- 7. invalid flag values -> non-zero exit -----------------------------
check("invalid --colors / --canvas-size / --coverage rejected (exit 1)", () => {
    const o = path.join(work, "bad.svg");
    for (const [flag, val] of [["--colors", "abc"], ["--colors", "0"],
        ["--canvas-size", "40by50"], ["--coverage", "-1"], ["--coverage", "0"]]) {
        const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, flag, val]);
        assert(r.code !== 0, `${flag} ${val}: expected non-zero exit, got ${r.code}`);
        assert(new RegExp(flag).test(r.stderr), `${flag} ${val}: expected error mentioning ${flag}, got: ${r.stderr}`);
    }
});

// ---- 8. parseCatalog: invalid JSON + duplicate sku ------------------------
check("catalog invalid-JSON and duplicate-sku rejected with clear error", () => {
    const o = path.join(work, "c.svg");
    const notJson = path.join(work, "notjson.json");
    fs.writeFileSync(notJson, "{ this is not valid json ]");
    let r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", notJson]);
    assert(r.code !== 0 && /Invalid catalog/.test(r.stderr),
        `invalid JSON: expected non-zero + 'Invalid catalog', got code ${r.code}: ${r.stderr}`);
    const dup = path.join(work, "dup.json");
    fs.writeFileSync(dup, JSON.stringify({ id: "d", name: "d", colors: [
        { sku: "A", name: "One", rgb: [0, 0, 0] },
        { sku: "A", name: "Two", rgb: [1, 1, 1] },
    ] }));
    r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", dup]);
    assert(r.code !== 0 && /Invalid catalog/.test(r.stderr) && /duplicate sku/i.test(r.stderr),
        `duplicate sku: expected non-zero + 'duplicate sku', got code ${r.code}: ${r.stderr}`);
});

// ---- 9. shopping-list.md is emitted and well-formed ----------------------
check("shopping-list.md emitted with header + one row per used paint", () => {
    const o = path.join(work, "md.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", GENERIC, "--colors", "16"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const md = fs.readFileSync(path.join(work, "md-shopping-list.md"), "utf8");
    assert(/^# Shopping list/m.test(md), "md missing '# Shopping list' header");
    assert(/\| # \| SKU \| Paint \| Swatch \| Area % \| Tubes \|/.test(md), "md missing table header");
    const csvRows = fs.readFileSync(path.join(work, "md-shopping-list.csv"), "utf8")
        .trim().split("\n").length - 1;
    const mdRows = [...md.matchAll(/^\| \d+ \| /gm)].length;
    assert(mdRows === csvRows, `md rows (${mdRows}) != csv rows (${csvRows})`);
});

// ---- 10. CSV name-quoting (paint name containing a comma) ----------------
check("CSV quotes paint names containing a comma", () => {
    const cat = path.join(work, "comma.json");
    // white maps to testinput's dominant background -> guaranteed a used row
    fs.writeFileSync(cat, JSON.stringify({ id: "cm", name: "cm", colors: [
        { sku: "W1", name: "White, Warm", rgb: [255, 255, 255] },
        { sku: "G1", name: "Green", rgb: [40, 150, 70] },
        { sku: "R1", name: "Red", rgb: [200, 30, 30] },
        { sku: "B1", name: "Light Blue", rgb: [120, 180, 220] },
    ] }));
    const o = path.join(work, "cm.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", cat, "--colors", "12"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const csv = fs.readFileSync(path.join(work, "cm-shopping-list.csv"), "utf8");
    assert(csv.includes('"White, Warm"'), `comma name must be quoted in CSV, got:\n${csv}`);
    // the quoted comma must not create an extra column
    const headerCols = csv.trim().split("\n")[0].split(",").length;
    const warmRow = csv.trim().split("\n").find((l) => l.includes("White, Warm"));
    // naive split would yield headerCols+1; quoted parse keeps column count stable
    assert(warmRow.split('","').length >= 1 && /,"White, Warm",/.test(warmRow),
        `quoted name should sit in its own field, row: ${warmRow}`);
    assert(headerCols === 6, `header should have 6 columns, got ${headerCols}`);
});

// ---- 11. duplicate RGB + oversized catalog rejected ----------------------
check("duplicate-rgb and oversized catalog rejected", () => {
    const o = path.join(work, "dr.svg");
    const dupRgb = path.join(work, "duprgb.json");
    fs.writeFileSync(dupRgb, JSON.stringify({ id: "x", name: "x", colors: [
        { sku: "A", name: "One", rgb: [10, 20, 30] },
        { sku: "B", name: "Two", rgb: [10, 20, 30] },
    ] }));
    let r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", dupRgb]);
    assert(r.code !== 0 && /Invalid catalog/.test(r.stderr) && /duplicate rgb/i.test(r.stderr),
        `dup rgb: expected non-zero + 'duplicate rgb', got ${r.code}: ${r.stderr}`);
    const big = path.join(work, "big.json");
    const colors = [];
    for (let i = 0; i < 600; i++) colors.push({ sku: `S${i}`, name: `n${i}`, rgb: [i % 256, (i * 3) % 256, (i * 7) % 256] });
    fs.writeFileSync(big, JSON.stringify({ id: "b", name: "b", colors }));
    r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", big]);
    assert(r.code !== 0 && /too many colors/i.test(r.stderr),
        `oversized catalog: expected non-zero + 'too many colors', got ${r.code}: ${r.stderr}`);
});

// ---- 12. resource-bound flag rejection -----------------------------------
check("--colors over cap and --canvas-size 0x0 rejected", () => {
    const o = path.join(work, "rb.svg");
    let r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--colors", "257"]);
    assert(r.code !== 0 && /--colors/.test(r.stderr), `--colors 257: expected reject, got ${r.code}: ${r.stderr}`);
    r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--canvas-size", "0x0"]);
    assert(r.code !== 0 && /canvas-size/.test(r.stderr), `0x0: expected reject, got ${r.code}: ${r.stderr}`);
});

// ---- 13. CSV/MD injection defanged ---------------------------------------
check("CSV formula + Markdown pipe/sku-comma neutralized", () => {
    const cat = path.join(work, "inj.json");
    fs.writeFileSync(cat, JSON.stringify({ id: "i", name: "i", colors: [
        { sku: "S,1", name: "=HYPERLINK(\"evil\")", rgb: [255, 255, 255] },
        { sku: "P|2", name: "Green | Blue", rgb: [40, 150, 70] },
        { sku: "R1", name: "Red", rgb: [200, 30, 30] },
        { sku: "B1", name: "Light Blue", rgb: [120, 180, 220] },
    ] }));
    const o = path.join(work, "inj.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", cat, "--colors", "12"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const csv = fs.readFileSync(path.join(work, "inj-shopping-list.csv"), "utf8");
    assert(/"'=HYPERLINK/.test(csv), `formula must be defanged with leading quote, got:\n${csv}`);
    assert(/"S,1"/.test(csv), `sku with comma must be quoted, got:\n${csv}`);
    // every data row must have exactly the 6 header columns when CSV-parsed
    const lines = csv.trim().split("\n");
    const cols = (line) => { // minimal RFC4180 field count
        let n = 1, q = false;
        for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) n++; }
        return n;
    };
    for (const l of lines) assert(cols(l) === 6, `row has ${cols(l)} cols, expected 6: ${l}`);
    const md = fs.readFileSync(path.join(work, "inj-shopping-list.md"), "utf8");
    assert(/Green \\\| Blue/.test(md), `md pipe must be escaped, got:\n${md}`);
    assert(/P\\\|2/.test(md), `md sku pipe must be escaped, got:\n${md}`);
});

// ---- 14. decimal --canvas-size + partial settings default-merge ----------
check("decimal --canvas-size propagates; partial settings falls back to defaults", () => {
    const o = path.join(work, "dec.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "12", "--canvas-size", "40.5x50", "--coverage", "0.0025"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    for (const row of fs.readFileSync(path.join(work, "dec-shopping-list.csv"), "utf8").trim().split("\n").slice(1)) {
        const f = row.split(",");
        const areaPct = Number(f[f.length - 2]);
        const tubes = Number(f[f.length - 1]);
        assert(tubes === Math.max(1, Math.ceil(areaPct * 40.5 * 50 * 0.0025)),
            `decimal canvas tube math wrong for row ${row}`);
    }
    const minimal = path.join(work, "min-settings.json");
    fs.writeFileSync(minimal, JSON.stringify({ randomSeed: 7707 }));
    const r2 = run(["-i", TESTINPUT, "-o", path.join(work, "min.svg"), "-c", minimal]);
    assert(r2.code === 0, `partial settings: expected exit 0 (defaults fill gaps), got ${r2.code}: ${r2.stderr}`);
    const pal = J(path.join(work, "min.json"));
    assert(Array.isArray(pal) && pal.length >= 1, "partial settings must still yield a valid palette");
});

// ---- 15. kit PDF + cover + canvas artifacts emitted ----------------------
// Tile-count math, mirrored from kitpdf.ts (A4, 1cm margin, 0.5cm overlap).
const A4 = { w: 21.0, h: 29.7 };
const tileCount = (canvasCm, paperCm) => {
    const printable = paperCm - 2 * 1.0;
    if (canvasCm <= printable) return 1;
    return Math.ceil((canvasCm - 0.5) / (printable - 0.5));
};
const pdfCount = (p) => {
    const m = fs.readFileSync(p, "latin1").match(/\/Count (\d+)/);
    return m ? Number(m[1]) : -1;
};
check("kit PDF + cover.png + canvas.svg emitted, single-sheet page count", () => {
    const o = path.join(work, "kit1.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "12", "--canvas-size", "10x12"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const pdf = path.join(work, "kit1-kit.pdf");
    const png = path.join(work, "kit1-cover.png");
    const csv = path.join(work, "kit1-canvas.svg");
    assert(fs.existsSync(pdf), "kit PDF not emitted");
    assert(fs.readFileSync(pdf, "latin1").startsWith("%PDF"), "kit PDF has no %PDF header");
    assert(fs.statSync(pdf).size > 2000, "kit PDF suspiciously small");
    const sig = fs.readFileSync(png).subarray(0, 8);
    assert(sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        "cover.png is not a PNG");
    assert(/viewBox="0 0 \d+ \d+"/.test(fs.readFileSync(csv, "utf8")),
        "canvas.svg missing viewBox (required for PDF scaling)");
    // 10x12 cm fits one A4 sheet -> cover + 1 canvas + 1 legend = 3
    assert(pdfCount(pdf) === 3, `single-sheet kit must be 3 pages, got ${pdfCount(pdf)}`);
});

// ---- 16. tiled kit: page count == cover + cols*rows + legend -------------
check("tiled kit page count matches tile math", () => {
    const o = path.join(work, "kit2.svg");
    const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "8", "--canvas-size", "40x50", "--paper", "A4"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const cols = tileCount(40, A4.w), rows = tileCount(50, A4.h);
    assert(cols > 1 && rows > 1, `fixture should tile, got ${cols}x${rows}`);
    // testinput is simple line art -> few paints -> single legend page
    const expected = 1 + cols * rows + 1;
    assert(pdfCount(path.join(work, "kit2-kit.pdf")) === expected,
        `tiled kit expected ${expected} pages (1 cover + ${cols}x${rows} + 1 legend), got ${pdfCount(path.join(work, "kit2-kit.pdf"))}`);
});

// ---- 17. CRITICAL print-legibility guard: tiny canvas suppresses numbers -
check("CRITICAL legibility guard suppresses sub-threshold numbers, keeps regions", () => {
    const big = path.join(work, "big.svg"), tiny = path.join(work, "tiny.svg");
    const rb = run(["-i", TESTINPUT, "-o", big, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "12", "--canvas-size", "200x250"]);
    const rt = run(["-i", TESTINPUT, "-o", tiny, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "12", "--canvas-size", "3x4"]);
    assert(rb.code === 0 && rt.code === 0, `runs failed: ${rb.stderr} ${rt.stderr}`);
    const txt = (p) => (fs.readFileSync(p, "utf8").match(/<\/text>/g) || []).length;
    const pth = (p) => (fs.readFileSync(p, "utf8").match(/<path/g) || []).length;
    const bigSvg = path.join(work, "big-canvas.svg"), tinySvg = path.join(work, "tiny-canvas.svg");
    assert(txt(bigSvg) > 0, "large canvas should keep its numbers");
    assert(txt(tinySvg) < txt(bigSvg), `tiny canvas must suppress numbers: tiny=${txt(tinySvg)} big=${txt(bigSvg)}`);
    assert(pth(tinySvg) === pth(bigSvg) && pth(tinySvg) > 0,
        `regions must be retained when numbers are suppressed: tiny=${pth(tinySvg)} big=${pth(bigSvg)}`);
});

// ---- 18. invalid --paper / --dpi rejected --------------------------------
check("invalid --paper / --dpi rejected (exit 1)", () => {
    const o = path.join(work, "pp.svg");
    for (const [flag, val] of [["--paper", "A3"], ["--dpi", "50"], ["--dpi", "abc"]]) {
        const r = run(["-i", TESTINPUT, "-o", o, "-c", SETTINGS, "--catalog", GENERIC, flag, val]);
        assert(r.code !== 0, `${flag} ${val}: expected non-zero exit, got ${r.code}`);
        assert(new RegExp(flag).test(r.stderr), `${flag} ${val}: expected error mentioning ${flag}, got: ${r.stderr}`);
    }
});

// ---- 19. CRITICAL batch isolation: one corrupt file must not abort --------
check("CRITICAL kit-batch isolation: corrupt file recorded, batch continues, exit 0", () => {
    const inDir = path.join(work, "batch-in");
    fs.mkdirSync(inDir, { recursive: true });
    fs.copyFileSync(TESTINPUT, path.join(inDir, "a.png"));
    fs.copyFileSync(SOLID_SRC, path.join(inDir, "b.png"));
    fs.writeFileSync(path.join(inDir, "c.png"), "this is not a PNG");
    const outDir = path.join(work, "batch-out");
    const r = run(["kit-batch", inDir, outDir, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "10", "--canvas-size", "20x25"]);
    assert(r.code === 0, `batch with a corrupt file must still exit 0, got ${r.code}: ${r.stderr}`);
    const m = J(path.join(outDir, "manifest.json"));
    assert(m.counts.total === 3 && m.counts.ok === 2 && m.counts.failed === 1,
        `expected total3/ok2/failed1, got ${JSON.stringify(m.counts)}`);
    const byFile = Object.fromEntries(m.images.map((i) => [i.file, i]));
    assert(byFile["a.png"].status === "ok" && typeof byFile["a.png"].sha256 === "string"
        && Array.isArray(byFile["a.png"].colorBOM), "a.png must be ok with sha256 + colorBOM");
    assert(byFile["c.png"].status === "error" && typeof byFile["c.png"].error === "string"
        && byFile["c.png"].error.length > 0, "c.png must be recorded as an error");
    // Kit folders are keyed by the full filename (collision-safe).
    assert(fs.existsSync(path.join(outDir, "a.png", "a-kit.pdf")), "a kit PDF must exist");
    assert(!fs.existsSync(path.join(outDir, "c.png")), "failed image must not leave a kit folder");
});

// ---- 20. CRITICAL determinism: two batch runs -> byte-identical manifest --
check("CRITICAL kit-batch determinism: manifest byte-identical across runs", () => {
    const inDir = path.join(work, "det-in");
    fs.mkdirSync(inDir, { recursive: true });
    fs.copyFileSync(TESTINPUT, path.join(inDir, "x.png"));
    fs.copyFileSync(SOLID_SRC, path.join(inDir, "y.png"));
    const a = path.join(work, "det-a"), b = path.join(work, "det-b");
    const args = (out) => ["kit-batch", inDir, out, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "12", "--canvas-size", "30x40"];
    const ra = run(args(a)), rb = run(args(b));
    assert(ra.code === 0 && rb.code === 0, `both runs must exit 0: ${ra.stderr} ${rb.stderr}`);
    const ma = fs.readFileSync(path.join(a, "manifest.json"));
    const mb = fs.readFileSync(path.join(b, "manifest.json"));
    assert(ma.equals(mb), "manifest.json must be byte-identical across two runs (same input+seed+catalog)");
});

// ---- 21. REGRESSION: same basename, different extension must not collide --
check("REGRESSION kit-batch: photo.jpg + photo.png get separate kits, no clobber", () => {
    const inDir = path.join(work, "coll-in");
    fs.mkdirSync(inDir, { recursive: true });
    fs.copyFileSync(TESTINPUT, path.join(inDir, "photo.png"));
    fs.copyFileSync(SOLID_SRC, path.join(inDir, "photo.jpg"));
    const outDir = path.join(work, "coll-out");
    const r = run(["kit-batch", inDir, outDir, "-c", SETTINGS, "--catalog", GENERIC,
        "--colors", "8", "--canvas-size", "20x25"]);
    assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const m = J(path.join(outDir, "manifest.json"));
    assert(m.counts.total === 2 && m.counts.ok === 2,
        `both same-basename images must succeed, got ${JSON.stringify(m.counts)}`);
    // Distinct kit folders (keyed by full filename), both with a real PDF —
    // proves the second image did not overwrite or delete the first.
    assert(fs.existsSync(path.join(outDir, "photo.png", "photo-kit.pdf")),
        "photo.png kit must exist independently");
    assert(fs.existsSync(path.join(outDir, "photo.jpg", "photo-kit.pdf")),
        "photo.jpg kit must exist independently");
    // Every ok entry's sha256 must correspond to a kit that is still on disk.
    for (const e of m.images.filter((x) => x.status === "ok")) {
        assert(fs.existsSync(path.join(outDir, e.file, "photo-kit.pdf")),
            `manifest reports ${e.file} ok but its kit is missing (lying manifest)`);
    }
});

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nkit-smoke: PASS" : `\nkit-smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
