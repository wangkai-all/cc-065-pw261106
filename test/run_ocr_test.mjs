/*
 * 用真实 OCR 跑通 samples/ 全部样本，校验字段提取、队列分类与重复/修订判定。
 * 运行：node test/run_ocr_test.mjs
 */
import { createWorker } from "tesseract.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WaybillExtract from "../app/js/extract.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(ROOT, "samples", "manifest.json"), "utf8"));

const worker = await createWorker(["chi_sim", "eng"], 1, {
  langPath: path.join(ROOT, "app", "vendor", "lang"),
  cacheMethod: "none",
  gzip: true,
});
await worker.setParameters({ tessedit_pageseg_mode: "11" });

let pass = 0;
let fail = 0;
const records = []; // 模拟收件台按顺序收件

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function norm(s) {
  return String(s || "").replace(/\s+/g, "");
}

for (const sample of manifest) {
  console.log(`\n== ${sample.file} [${sample.tags.join(", ")}]`);
  const img = await readFile(path.join(ROOT, "samples", sample.file));
  const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
  const lines = WaybillExtract.normalizeLines(data);
  const fields = WaybillExtract.extractFields(lines);
  const flags = WaybillExtract.classify(fields, sample.laplacianVar);
  const score = WaybillExtract.recordScore(fields);
  console.log(
    `  识别: 单号=${fields.waybillNo.value || "(空)"} 发货地=${fields.origin.value || "(空)"} ` +
      `目的地=${fields.destination.value || "(空)"} 重量=${fields.weight.value || "(空)"} ` +
      `日期=${fields.date.value || "(空)"} 得分=${score} 平均置信=${fields._meanConfidence}`
  );

  const exp = sample.expect;
  const isBlurry = sample.tags.includes("blurry");
  // 模糊件只要求进模糊队列，字段不作硬性断言（识别结果允许残缺）
  if (!isBlurry) {
    check("运单号", WaybillExtract.normalizeWaybillNo(fields.waybillNo.value) === WaybillExtract.normalizeWaybillNo(exp.waybillNo),
      `期望 ${exp.waybillNo} 实得 ${fields.waybillNo.value}`);
    check("发货地", norm(fields.origin.value) === norm(exp.origin), `期望 ${exp.origin} 实得 ${fields.origin.value}`);
    check("目的地", norm(fields.destination.value) === norm(exp.destination), `期望 ${exp.destination} 实得 ${fields.destination.value}`);
    check("日期", WaybillExtract.normalizeDate(fields.date.value) === exp.date, `期望 ${exp.date} 实得 ${fields.date.value}`);
    if (exp.weight === "") check("重量缺失", !fields.weight.value, `实得 ${fields.weight.value}`);
    else check("重量", WaybillExtract.normalizeWeight(fields.weight.value) === exp.weight, `期望 ${exp.weight} 实得 ${fields.weight.value}`);
  }

  check("模糊队列判定", flags.blurry === isBlurry, `blurry=${flags.blurry}`);
  const expectMissing = sample.tags.filter((t) => t.startsWith("missing:")).map((t) => t.split(":")[1]);
  if (!isBlurry) {
    // 模糊件字段允许残缺，不强制缺字段队列内容
    check("缺字段队列判定",
      expectMissing.length === flags.missing.length && expectMissing.every((f) => flags.missing.includes(f)),
      `missing=${flags.missing.join(",")}`);
  }
  check("格式错误队列判定", flags.badFormat === sample.tags.includes("bad_format"), `badFormat=${flags.badFormat}`);

  // 重复 / 修订判定（模拟入库流程）
  const dup = WaybillExtract.detectDuplicate(fields, records);
  const dupTag = sample.tags.find((t) => t.startsWith("duplicate_of:"));
  const revTag = sample.tags.find((t) => t.startsWith("revision_of:"));
  if (dupTag) check("判为重复件", dup && dup.type === "duplicate", `实得 ${JSON.stringify(dup)}`);
  else if (revTag) check("判为修订件（不丢弃）", dup && dup.type === "revision", `实得 ${JSON.stringify(dup)}`);
  else check("非重复件", dup === null, `实得 ${JSON.stringify(dup)}`);

  records.push({
    id: `r${records.length}`,
    status: dup && dup.type === "duplicate" ? "duplicate" : "pending",
    fields,
  });
}

await worker.terminate();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
