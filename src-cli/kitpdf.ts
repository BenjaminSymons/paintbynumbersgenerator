/**
 * Kit PDF builder (Phase 1 step 4). Composes a print-ready, true-physical-size
 * paint-by-numbers kit:
 *
 *   page 1            colored cover preview (raster) + approximate-colour note
 *   pages 2..(N+1)    the numbered canvas, tiled across `--paper` sheets at the
 *                     declared `--canvas-size`, with crop ticks + seam labels
 *   last page(s)      swatch legend (number + sku + name + colour)
 *
 * Scaling policy: the canvas is drawn at exactly the declared `--canvas-size`
 * (1 cm of canvas = 1 cm of paper, `preserveAspectRatio="none"`). The user
 * declares the physical size; the kit honours it exactly even if the source
 * image's pixel aspect differs slightly.
 *
 * Font: labels are rendered with the PDF core font Helvetica. The design doc's
 * step-0 spike suggested vendoring a libre TTF (DejaVu) to avoid a
 * platform-dependent Tahoma->Helvetica *fallback*. Choosing Helvetica
 * explicitly reaches the same goal — Helvetica is one of the 14 standard PDF
 * fonts, its metrics ship inside pdfkit and its glyphs are rendered identically
 * by every conformant PDF viewer — without committing a ~700 KB binary for what
 * are only digits. (PDF byte-identity is a Phase 2 / manifest concern; the doc
 * requires the PDF to be visually equivalent, not byte-identical.)
 */
import * as fs from "fs";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";

export interface LegendRow {
    number: number;
    sku: string;
    name: string;
    hex: string;
}

export interface KitPdfOptions {
    outPath: string;
    /** Borders + legibility-guarded labels, no fill. Must carry a viewBox. */
    canvasSvg: string;
    /** Rasterized colored preview for the cover. */
    coverPng: Buffer;
    legend: LegendRow[];
    catalogName: string;
    canvasWidthCm: number;
    canvasHeightCm: number;
    paperWidthCm: number;
    paperHeightCm: number;
}

const PT_PER_CM = 72 / 2.54;
const MARGIN_CM = 1.0;
const OVERLAP_CM = 0.5;
// A tiled job past this many sheets is a misuse (wrong canvas/paper), not a
// kit anyone prints — fail loudly rather than spool hundreds of pages.
const MAX_TILE_PAGES = 200;
const TICK_CM = 0.5;

const APPROX_NOTE =
    "Colours are the closest catalog swatch — approximate, not calibrated paint matches.";

function tileCount(canvasCm: number, printableCm: number): number {
    if (canvasCm <= printableCm) return 1;
    const stepCm = printableCm - OVERLAP_CM;
    return Math.ceil((canvasCm - OVERLAP_CM) / stepCm);
}

export async function buildKitPdf(opts: KitPdfOptions): Promise<{ pages: number; cols: number; rows: number }> {
    const printableWcm = opts.paperWidthCm - 2 * MARGIN_CM;
    const printableHcm = opts.paperHeightCm - 2 * MARGIN_CM;
    if (printableWcm <= OVERLAP_CM || printableHcm <= OVERLAP_CM) {
        throw new Error(`paper ${opts.paperWidthCm}x${opts.paperHeightCm} cm is too small for a ${MARGIN_CM} cm margin`);
    }

    const cols = tileCount(opts.canvasWidthCm, printableWcm);
    const rows = tileCount(opts.canvasHeightCm, printableHcm);
    if (cols * rows > MAX_TILE_PAGES) {
        throw new Error(
            `canvas ${opts.canvasWidthCm}x${opts.canvasHeightCm} cm on ${opts.paperWidthCm}x${opts.paperHeightCm} cm paper ` +
            `needs ${cols * rows} sheets (max ${MAX_TILE_PAGES}); use a larger --paper or smaller --canvas-size`);
    }

    const pageWpt = opts.paperWidthCm * PT_PER_CM;
    const pageHpt = opts.paperHeightCm * PT_PER_CM;
    const marginPt = MARGIN_CM * PT_PER_CM;
    const printableWpt = printableWcm * PT_PER_CM;
    const printableHpt = printableHcm * PT_PER_CM;

    const doc = new PDFDocument({
        size: [pageWpt, pageHpt],
        margin: 0,
        autoFirstPage: true,
        info: { Title: `Paint-by-numbers kit — ${opts.catalogName}` },
    });
    const stream = fs.createWriteStream(opts.outPath);
    const done = new Promise<void>((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
    });
    doc.pipe(stream);

    const helv = () => "Helvetica";

    // ---- Cover ------------------------------------------------------------
    doc.font("Helvetica").fontSize(18).fillColor("#000")
        .text(`Paint-by-numbers kit — ${opts.catalogName}`, marginPt, marginPt, { width: printableWpt });
    const coverTop = marginPt + 32;
    doc.image(opts.coverPng, marginPt, coverTop, {
        fit: [printableWpt, printableHpt - 64],
        align: "center",
        valign: "center",
    });
    doc.fontSize(9).fillColor("#555")
        .text(APPROX_NOTE, marginPt, pageHpt - marginPt - 14, { width: printableWpt });

    // ---- Tiled numbered canvas -------------------------------------------
    const canvasWpt = opts.canvasWidthCm * PT_PER_CM;
    const canvasHpt = opts.canvasHeightCm * PT_PER_CM;
    const stepWpt = (printableWcm - OVERLAP_CM) * PT_PER_CM;
    const stepHpt = (printableHcm - OVERLAP_CM) * PT_PER_CM;
    const tickPt = TICK_CM * PT_PER_CM;
    const tiled = cols * rows > 1;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            doc.addPage();

            doc.save();
            doc.rect(marginPt, marginPt, printableWpt, printableHpt).clip();
            SVGtoPDF(doc, opts.canvasSvg,
                marginPt - c * stepWpt,
                marginPt - r * stepHpt,
                {
                    width: canvasWpt,
                    height: canvasHpt,
                    preserveAspectRatio: "none",
                    fontCallback: helv,
                });
            doc.restore();

            // Corner crop ticks: hand-alignment aid for tiled sheets.
            doc.save().lineWidth(0.5).strokeColor("#000");
            const corners: [number, number, number, number][] = [
                [marginPt, marginPt, 1, 1],
                [marginPt + printableWpt, marginPt, -1, 1],
                [marginPt, marginPt + printableHpt, 1, -1],
                [marginPt + printableWpt, marginPt + printableHpt, -1, -1],
            ];
            for (const [x, y, sx, sy] of corners) {
                doc.moveTo(x, y).lineTo(x + sx * tickPt, y).stroke();
                doc.moveTo(x, y).lineTo(x, y + sy * tickPt).stroke();
            }
            doc.restore();

            if (tiled) {
                doc.font("Helvetica").fontSize(8).fillColor("#444").text(
                    `Sheet row ${r + 1}/${rows}, col ${c + 1}/${cols} — ` +
                    `${OVERLAP_CM * 10} mm overlap with adjacent sheets; align on the crop ticks.`,
                    marginPt, marginPt - 12,
                    { width: printableWpt, lineBreak: false });
            }
        }
    }

    // ---- Swatch legend ----------------------------------------------------
    const rowH = 22;
    const swatch = 16;
    let pages = 1 + cols * rows;
    const legendTop = marginPt + 28;
    const newLegendPage = () => {
        doc.addPage();
        pages++;
        doc.font("Helvetica").fontSize(16).fillColor("#000")
            .text(`Paint legend — ${opts.catalogName}`, marginPt, marginPt, { width: printableWpt });
        return legendTop;
    };
    let y = newLegendPage();
    for (const row of opts.legend) {
        if (y + rowH > pageHpt - marginPt - 20) y = newLegendPage();
        doc.save().rect(marginPt, y, swatch, swatch).fillColor(row.hex).fill().restore();
        doc.font("Helvetica").fontSize(11).fillColor("#000").text(
            `${row.number}.  ${row.sku}  —  ${row.name}`,
            marginPt + swatch + 10, y + 3,
            { width: printableWpt - swatch - 10, lineBreak: false });
        y += rowH;
    }
    doc.fontSize(9).fillColor("#555")
        .text(APPROX_NOTE, marginPt, pageHpt - marginPt - 14, { width: printableWpt });

    doc.end();
    await done;
    return { pages, cols, rows };
}
