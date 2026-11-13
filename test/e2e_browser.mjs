/*
 * 端到端验证：起本地 HTTP 服务 → 无头浏览器打开收件台 → 载入演示样本 →
 * 校验队列分布、重复/修订判定、字段修正留痕与确认流程。
 * 运行：node test/e2e_browser.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8321;

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: ROOT,
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 1200));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on("pageerror", (e) => console.log("  [页面错误]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: "load" });
  check("页面加载", (await page.locator("h1").textContent()) === "运单影像收件台");

  // 载入演示样本（8 张，浏览器内 OCR，耐心等待进度条消失即全部入库）
  await page.click("#btnDemo");
  await page.waitForSelector("#progressWrap", { state: "visible", timeout: 30000 });
  await page.waitForSelector("#progressWrap", { state: "hidden", timeout: 300000 });
  await page.waitForTimeout(500);

  const tabCount = async (label) => {
    const txt = await page.locator(".queue-tab", { hasText: label }).textContent();
    return parseInt(txt.match(/(\d+)\s*$/)?.[1] || "-1", 10);
  };
  console.log("\n== 队列分布 ==");
  const counts = {
    待复核: await tabCount("待复核"),
    模糊图像: await tabCount("模糊图像"),
    字段缺失: await tabCount("字段缺失"),
    格式错误: await tabCount("格式错误"),
    修订件: await tabCount("修订件"),
    重复件: await tabCount("重复件"),
    已确认: await tabCount("已确认"),
  };
  console.log(" ", JSON.stringify(counts));
  check("待复核 7 条", counts.待复核 === 7);
  check("重复件 1 条", counts.重复件 === 1);
  check("模糊图像 1 条", counts.模糊图像 === 1);
  check("字段缺失 2 条（模糊件缺发货地 + 缺重量件）", counts.字段缺失 === 2);
  check("格式错误 1 条", counts.格式错误 === 1);
  check("修订件 1 条", counts.修订件 === 1);
  check("已确认 0 条", counts.已确认 === 0);

  // 待复核列表应按置信分升序：第一条应是得分最低的（模糊件或缺字段件，得分 0）
  const firstScore = await page.locator(".record-card .score-label").first().textContent();
  check("列表按置信分升序（首条得分最低）", /0%/.test(firstScore), firstScore);

  console.log("\n== 重复件 ==");
  await page.locator(".queue-tab", { hasText: "重复件" }).click();
  await page.locator(".record-card").first().click();
  const dupBanner = await page.locator("#dupBanner").textContent();
  check("重复件提示条", dupBanner.includes("重复扫描件") && dupBanner.includes("YD8801234567"), dupBanner);
  check("重复件禁止确认", await page.locator("#btnConfirm").isDisabled());

  console.log("\n== 修订件 ==");
  await page.locator(".queue-tab", { hasText: "修订件" }).click();
  await page.locator(".record-card").first().click();
  const warnBanner = await page.locator("#warnBanner").textContent();
  check("修订件提示（不丢弃）", warnBanner.includes("修订件") && warnBanner.includes("重量或日期不同"), warnBanner);
  const revWeight = await page.locator('[data-field-input="weight"]').inputValue();
  check("修订件重量为 9.6", revWeight === "9.6", revWeight);

  console.log("\n== 格式错误件 ==");
  await page.locator(".queue-tab", { hasText: "格式错误" }).click();
  await page.locator(".record-card").first().click();
  check("格式错误提示", (await page.locator("#warnBanner").textContent()).includes("编号规则"));

  console.log("\n== 模糊件：修正 + 确认 ==");
  await page.locator(".queue-tab", { hasText: "模糊图像" }).click();
  await page.locator(".record-card").first().click();
  check("模糊提示", (await page.locator("#warnBanner").textContent()).includes("模糊"));
  // 修正缺失的发货地
  await page.locator('[data-field-input="origin"]').fill("南京市鼓楼区");
  await page.waitForTimeout(300);
  check("修正后输入框标记 edited", await page.locator('[data-field-input="origin"].edited').count() === 1);
  // 字段定位：聚焦日期输入框 → 图上对应框高亮
  await page.locator('[data-field-input="date"]').focus();
  await page.waitForTimeout(300);
  check("图上定位框高亮联动", await page.locator(".field-box.active").count() === 1);
  // 确认（该件单号格式合法，不应弹确认框；监听 dialog 以防意外）
  page.once("dialog", (d) => d.accept());
  await page.click("#btnConfirm");
  await page.waitForTimeout(400);
  check("确认后进入已确认队列", (await tabCount("已确认")) === 1);
  const history = await page.locator("#historyList").textContent();
  check("历史含人工修正留痕", history.includes("人工修正") && history.includes("发货地"), history);
  check("历史含确认记录", history.includes("确认"));
  const meta = await page.locator(".field-row[data-field='origin'] .field-meta").textContent();
  check("字段保留识别原值与修改时间", meta.includes("识别原值") && meta.includes("修改时间"), meta);

  await page.screenshot({ path: path.join(ROOT, "test", "e2e-screenshot.png"), fullPage: false });
  await browser.close();
} finally {
  server.kill();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
