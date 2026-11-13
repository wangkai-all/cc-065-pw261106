/* OCR 引擎封装（tesseract.js 完全在浏览器本地运行）+ 图像模糊度检测 */
(function (root) {
  "use strict";

  let workerPromise = null;

  /** 惰性初始化识别引擎：加载本地 vendor 下的 worker / wasm 内核 / 中英文语言包 */
  function ensureWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = (async () => {
        const worker = await Tesseract.createWorker(["chi_sim", "eng"], 1, {
          workerPath: "vendor/worker.min.js",
          corePath: "vendor/core",
          langPath: "vendor/lang",
          gzip: true,
          logger: (m) => {
            if (onProgress && m.status) onProgress(m.status, m.progress || 0);
          },
        });
        // PSM 11：稀疏文本模式，最适合运单/表单类版式
        await worker.setParameters({ tessedit_pageseg_mode: "11" });
        return worker;
      })();
    }
    return workerPromise;
  }

  /** 识别一张图片（Image/Blob/dataURL），返回 { lines, meanConfidence } */
  async function recognize(image, onProgress) {
    const worker = await ensureWorker(onProgress);
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
    const lines = root.WaybillExtract.normalizeLines(data);
    return { lines, raw: data };
  }

  /**
   * 图像模糊度：灰度图 Laplacian 方差（下采样到宽 400，与样本校准口径一致）。
   * 值越小越模糊；阈值见 extract.js 的 BLUR_LAPVAR_THRESHOLD。
   */
  function laplacianVariance(img) {
    const W = 400;
    const scale = W / img.naturalWidth;
    const H = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const gray = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const lap =
          4 * gray[y * W + x] -
          gray[y * W + x - 1] -
          gray[y * W + x + 1] -
          gray[(y - 1) * W + x] -
          gray[(y + 1) * W + x];
        sum += lap;
        sumSq += lap * lap;
        n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = src;
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("读取文件失败"));
      r.readAsDataURL(file);
    });
  }

  root.WaybillOCR = { recognize, laplacianVariance, loadImage, fileToDataUrl };
})(window);
