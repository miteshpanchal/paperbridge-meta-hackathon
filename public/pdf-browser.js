let library;
async function pdfjs(BASE) {
  if (!library) {
    library = await import(BASE + "/vendor/pdfjs/build/pdf.mjs");
    library.GlobalWorkerOptions.workerSrc =
      BASE + "/vendor/pdfjs/build/pdf.worker.mjs";
  }
  return library;
}
export async function openPdf(file, BASE) {
  const pdf = await pdfjs(BASE);
  return pdf.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: BASE + "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: BASE + "/vendor/pdfjs/standard_fonts/",
    wasmUrl: BASE + "/vendor/pdfjs/wasm/",
  }).promise;
}
async function raster(page, width = 160) {
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(width / original.width, 2400 / original.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({
    canvasContext: canvas.getContext("2d", { alpha: false }),
    viewport,
    background: "white",
  }).promise;
  const image = canvas.toDataURL("image/jpeg", width > 160 ? 0.9 : 0.8);
  canvas.width = canvas.height = 0;
  return image;
}
export async function inspectPdf(document, offset, BASE) {
  const { OPS } = await pdfjs(BASE),
    previews = [];
  for (
    let index = offset;
    index < Math.min(offset + 24, document.numPages);
    index++
  ) {
    const page = await document.getPage(index + 1);
    const text = (await page.getTextContent()).items
      .map((item) => item.str || "")
      .join(" ");
    const operators = await page.getOperatorList();
    const imageOps = [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
    ];
    const hasVisuals =
      text.trim().length < 80 ||
      operators.fnArray.some((n) => imageOps.includes(n)) ||
      operators.fnArray.filter((n) => n === OPS.constructPath).length > 8;
    previews.push({
      sourcePage: index + 1,
      thumbnail: await raster(page),
      nativeTextLength: text.length,
      hasVisuals,
    });
    page.cleanup();
  }
  return { pageCount: document.numPages, offset, batchSize: 24, previews };
}
export async function renderPdfPage(document, index) {
  const page = await document.getPage(index + 1);
  const nativeText = (await page.getTextContent()).items
    .map((item) => item.str || "")
    .join(" ")
    .slice(0, 25000);
  const result = {
    sourcePage: index + 1,
    nativeText,
    image: await raster(page, 1800),
  };
  page.cleanup();
  return result;
}
export async function imagePreview(file) {
  const image = await createImageBitmap(file),
    ratio = Math.min(1, 1800 / image.width, 2400 / image.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * ratio);
  canvas.height = Math.round(image.height * ratio);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const result = canvas.toDataURL("image/jpeg", 0.92);
  canvas.width = canvas.height = 0;
  return result;
}
