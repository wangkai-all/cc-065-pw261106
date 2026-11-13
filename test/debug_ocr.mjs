// 调试：打印指定样本的原始 OCR 行
import { createWorker } from "tesseract.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = process.argv.slice(2);
const langDir = process.env.LANG_DIR || path.join(ROOT, "app", "vendor", "lang");
const worker = await createWorker(["chi_sim", "eng"], 1, { langPath: langDir, cacheMethod: "none", gzip: true });
for (const f of files) {
  const img = await readFile(path.join(ROOT, "samples", f));
  const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
  console.log(`\n===== ${f} =====`);
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const b = line.bbox;
        console.log(`[${b.x0},${b.y0}-${b.x1},${b.y1}] conf=${Math.round(line.confidence)} :: ${JSON.stringify(line.text)}`);
      }
    }
  }
}
await worker.terminate();
