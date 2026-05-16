// Minimal ambient declarations for the two PDF deps. `@types/pdfkit` is not
// installed (and tsconfig's `types` allowlist would exclude it anyway); only
// the small surface the kit PDF builder uses is declared here.
declare module "pdfkit" {
    interface PDFDocumentOptions {
        size?: [number, number] | string;
        margin?: number;
        margins?: { top: number; bottom: number; left: number; right: number };
        autoFirstPage?: boolean;
        compress?: boolean;
        info?: Record<string, string>;
    }
    class PDFDocument {
        constructor(options?: PDFDocumentOptions);
        readonly page: { width: number; height: number };
        y: number;
        addPage(options?: PDFDocumentOptions): this;
        save(): this;
        restore(): this;
        translate(x: number, y: number): this;
        scale(s: number): this;
        rect(x: number, y: number, w: number, h: number): this;
        clip(): this;
        moveTo(x: number, y: number): this;
        lineTo(x: number, y: number): this;
        lineWidth(w: number): this;
        strokeColor(c: string): this;
        fillColor(c: string): this;
        stroke(): this;
        fill(c?: string): this;
        font(src: string): this;
        fontSize(n: number): this;
        text(text: string, x?: number, y?: number, options?: Record<string, unknown>): this;
        image(src: Buffer | string, x?: number, y?: number, options?: Record<string, unknown>): this;
        widthOfString(text: string): number;
        pipe(dest: NodeJS.WritableStream): NodeJS.WritableStream;
        end(): void;
    }
    export = PDFDocument;
}

declare module "svg-to-pdfkit" {
    import PDFDocument from "pdfkit";
    interface SVGtoPDFOptions {
        width?: number;
        height?: number;
        preserveAspectRatio?: string;
        assumePt?: boolean;
        fontCallback?: (family: string, bold: boolean, italic: boolean) => string;
    }
    function SVGtoPDF(
        doc: PDFDocument,
        svg: string,
        x: number,
        y: number,
        options?: SVGtoPDFOptions,
    ): void;
    export = SVGtoPDF;
}
