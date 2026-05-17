import { downloadPalettePng, downloadPNG, downloadSVG, loadExample, process, updateOutput } from "./gui";
import { Clipboard } from "./lib/clipboard";

$(document).ready(function () {

    $(".tabs").tabs();
    $(".tooltipped").tooltip();

    const clip = new Clipboard("canvas", true);

    function drawImageFile(file: File) {
        const reader = new FileReader();
        reader.onloadend = function () {
            const img = document.createElement("img");
            img.onload = () => {
                const c = document.getElementById("canvas") as HTMLCanvasElement;
                const ctx = c.getContext("2d")!;
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                ctx.drawImage(img, 0, 0);
            };
            img.onerror = () => {
                alert("Unable to load image");
            }
            img.src = <string>reader.result;
        }
        reader.readAsDataURL(file);
    }

    $("#file").change(function (ev) {
        const files = (<HTMLInputElement>$("#file").get(0)).files;
        if (files !== null && files.length > 0) {
            drawImageFile(files[0]);
        }
    });

    $("#btnBrowse").click(() => $("#file").trigger("click"));

    const dropzone = document.getElementById("dropzone")!;
    ["dragenter", "dragover"].forEach((evt) => dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
    }));
    dropzone.addEventListener("drop", (e: DragEvent) => {
        const files = e.dataTransfer?.files;
        if (files && files.length > 0 && files[0].type.startsWith("image/")) {
            drawImageFile(files[0]);
        }
    });

    loadExample("imgSmall");

    $("#btnProcess").click(async function () {
        try {
            await process();
        } catch (err) {
            alert("Error: " + err);
        }
    });

    $("#chkShowLabels, #chkFillFacets, #chkShowBorders, #txtSizeMultiplier, #txtLabelFontSize, #txtLabelFontColor").change(async () => {
        await updateOutput();
    });

    $("#btnDownloadSVG").click(function () {
        downloadSVG();
    });

    $("#btnDownloadPNG").click(function () {
        downloadPNG();
    });

    $("#btnDownloadPalettePNG").click(function () {
        downloadPalettePng();
    });

    $("#lnkTrivial").click(() => { loadExample("imgTrivial"); return false; });
    $("#lnkSmall").click(() => { loadExample("imgSmall"); return false; });
    $("#lnkMedium").click(() => { loadExample("imgMedium"); return false; });
});
