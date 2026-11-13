/*
 * 运单字段提取与分类 —— 纯逻辑模块，浏览器（window.WaybillExtract）与 Node（module.exports）共用。
 * 输入为 tesseract.js 的识别结果（建议 PSM 11 稀疏文本模式），
 * 输出结构化字段、置信度、队列标记与重复/修订判定。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WaybillExtract = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 运单号规则：2 位字母 + 10 位数字
  const WAYBILL_RE = /^[A-Z]{2}\d{10}$/;
  // Laplacian 方差低于该值视为模糊（依据 samples/manifest.json 校准：清晰件 >4500，模糊件 <500）
  const BLUR_LAPVAR_THRESHOLD = 1000;
  const BLUR_OCR_CONF_THRESHOLD = 45;

  const FIELDS = ["waybillNo", "origin", "destination", "weight", "date"];
  const FIELD_LABELS = {
    waybillNo: "运单号",
    origin: "发货地",
    destination: "目的地",
    weight: "重量",
    date: "日期",
  };

  // 各字段在运单上可能出现的标签（匹配前会去除空格并转大写）
  const LABEL_MAP = {
    waybillNo: ["运单号", "单号", "运单编号", "WAYBILLNO", "WAYBILL"],
    origin: ["发货地", "始发地", "寄件地", "FROM"],
    destination: ["目的地", "到达地", "收件地", "TO"],
    weight: ["重量", "毛重", "WEIGHT"],
    date: ["日期", "发货日期", "寄件日期", "DATE"],
  };

  function compact(s) {
    return String(s || "").replace(/\s+/g, "").toUpperCase();
  }

  /** 从 tesseract.js recognize 结果整理出行列表：[{text, confidence, bbox, words}] */
  function normalizeLines(data) {
    const lines = [];
    const pushLine = (line) => {
      const words = (line.words || []).map((w) => ({
        text: w.text,
        confidence: w.confidence,
        bbox: w.bbox,
      }));
      lines.push({
        text: line.text || words.map((w) => w.text).join(" "),
        confidence: line.confidence || 0,
        bbox: line.bbox || null,
        words,
      });
    };
    if (data && Array.isArray(data.blocks)) {
      for (const block of data.blocks)
        for (const para of block.paragraphs || [])
          for (const line of para.lines || []) pushLine(line);
    } else if (data && Array.isArray(data.lines)) {
      for (const line of data.lines) pushLine(line);
    } else if (data && typeof data.text === "string") {
      for (const t of data.text.split(/\r?\n/))
        if (t.trim()) lines.push({ text: t, confidence: 0, bbox: null, words: [] });
    }
    return lines.filter((l) => l.text && l.text.trim());
  }

  function unionBbox(bboxes) {
    const valid = bboxes.filter(Boolean);
    if (!valid.length) return null;
    return {
      x0: Math.min(...valid.map((b) => b.x0)),
      y0: Math.min(...valid.map((b) => b.y0)),
      x1: Math.max(...valid.map((b) => b.x1)),
      y1: Math.max(...valid.map((b) => b.y1)),
    };
  }

  function normalizeWaybillNo(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function normalizeDate(s) {
    const m = String(s || "").match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/);
    if (!m) return String(s || "").trim();
    const pad = (x) => String(x).padStart(2, "0");
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  }

  function normalizeWeight(s) {
    const m = String(s || "").match(/(\d+(?:\.\d+)?)/);
    return m ? m[1] : String(s || "").trim();
  }

  /** 在行文本（已压缩）中查找全部字段标签，按位置排序并去重叠 */
  function findLabelMatches(lineCompact) {
    const matches = [];
    for (const key of FIELDS) {
      for (const label of LABEL_MAP[key]) {
        let from = 0;
        for (;;) {
          const idx = lineCompact.indexOf(label, from);
          if (idx === -1) break;
          matches.push({ pos: idx, len: label.length, field: key, label });
          from = idx + label.length;
        }
      }
    }
    matches.sort((a, b) => a.pos - b.pos || b.len - a.len);
    const kept = [];
    let covered = -1;
    for (const m of matches) {
      if (m.pos < covered) continue; // 与已保留标签重叠，丢弃
      kept.push(m);
      covered = m.pos + m.len;
    }
    return kept;
  }

  function cleanValue(s) {
    return String(s || "").replace(/^[:：.。·\-—_\s]+/, "").replace(/[|｜\s]+$/, "").trim();
  }

  function normalizeFieldValue(key, raw) {
    if (key === "waybillNo") return normalizeWaybillNo(raw);
    if (key === "date") return normalizeDate(raw);
    if (key === "weight") return normalizeWeight(raw);
    return String(raw || "").replace(/^[“"'‘’]+|[”"'‘’]+$/g, "").trim();
  }

  /** 把词按其在行文本中的位置归属到某个标签段，返回值词的并集边界框与平均置信度 */
  function wordStatsForSpan(line, spanStart, spanEnd) {
    const words = line.words || [];
    if (!words.length || !line.bbox) return { bbox: line.bbox || null, confidence: line.confidence || 0 };
    // 计算每个词在压缩行文本中的字符区间
    const lc = compact(line.text);
    let cursor = 0;
    const spans = words.map((w) => {
      const wc = compact(w.text);
      if (!wc) return null;
      const idx = lc.indexOf(wc, cursor);
      if (idx === -1) return null;
      cursor = idx + wc.length;
      return { start: idx, end: idx + wc.length, w };
    });
    const inside = spans.filter((s) => s && s.end > spanStart && s.start < spanEnd).map((s) => s.w);
    const use = inside.length ? inside : words;
    return {
      bbox: unionBbox(use.map((w) => w.bbox)) || line.bbox,
      confidence: use.reduce((s, w) => s + (w.confidence || 0), 0) / use.length,
    };
  }

  /**
   * 从行列表提取五个字段。
   * 两遍法：先解析行内“标签-值”段；再将“只有标签”的行与右侧/下方的无标签行做空间配对。
   */
  function extractFields(lines) {
    const fields = {};
    for (const key of FIELDS) fields[key] = { value: "", raw: "", confidence: 0, bbox: null };
    const pendingLabels = []; // {field, line, labelEnd}
    const freeLines = []; // 无任何标签的行，供配对：{line, used}
    let confSum = 0;
    let confN = 0;

    for (const line of lines) {
      const lc = compact(line.text);
      if (!lc) continue;
      for (const w of line.words || []) {
        confSum += w.confidence || 0;
        confN++;
      }
      const matches = findLabelMatches(lc);
      if (!matches.length) {
        freeLines.push({ line, used: false });
        continue;
      }
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const spanStart = m.pos + m.len;
        const spanEnd = i + 1 < matches.length ? matches[i + 1].pos : lc.length;
        const rawValue = cleanValue(lc.slice(spanStart, spanEnd));
        const value = normalizeFieldValue(m.field, rawValue);
        if (value && !fields[m.field].value) {
          const stats = wordStatsForSpan(line, spanStart, spanEnd);
          fields[m.field] = {
            value,
            raw: rawValue,
            confidence: Math.round(stats.confidence) / 100,
            bbox: stats.bbox,
          };
        } else if (!value) {
          pendingLabels.push({ field: m.field, line, labelEnd: m.pos + m.len });
        }
      }
    }

    // 空间配对：标签行 → 同一行右侧 / 正下方的无标签行
    for (const p of pendingLabels) {
      if (fields[p.field].value) continue;
      const lb = p.line.bbox;
      if (!lb) continue;
      const h = lb.y1 - lb.y0 || 30;
      const yc = (lb.y0 + lb.y1) / 2;
      let best = null;
      let bestCost = Infinity;
      for (const cand of freeLines) {
        if (cand.used) continue;
        const cb = cand.line.bbox;
        if (!cb) continue;
        const cyc = (cb.y0 + cb.y1) / 2;
        const sameRow = Math.abs(cyc - yc) < h * 0.8 && cb.x0 > lb.x0 - 20;
        const below = cb.y0 >= lb.y1 - 4 && cb.y0 - lb.y1 < h * 1.6 &&
          Math.min(cb.x1, lb.x1) - Math.max(cb.x0, lb.x0) > -30;
        if (!sameRow && !below) continue;
        const cost = sameRow
          ? Math.abs(cyc - yc) + Math.max(0, cb.x0 - lb.x1) * 0.1
          : 100 + (cb.y0 - lb.y1);
        if (cost < bestCost) {
          bestCost = cost;
          best = cand;
        }
      }
      if (best) {
        best.used = true;
        const rawValue = cleanValue(compact(best.line.text));
        const value = normalizeFieldValue(p.field, rawValue);
        if (value) {
          fields[p.field] = {
            value,
            raw: rawValue,
            confidence: Math.round((best.line.confidence || 0)) / 100,
            bbox: best.line.bbox,
          };
        }
      }
    }

    // 兜底：运单号 / 日期 / 重量 按格式在剩余行中搜索
    const fallback = (key, re, norm) => {
      if (fields[key].value) return;
      for (const { line } of freeLines) {
        const m = compact(line.text).match(re);
        if (m) {
          fields[key] = {
            value: norm(m[0]),
            raw: m[0],
            confidence: Math.round((line.confidence || 40) * 0.8) / 100,
            bbox: line.bbox || null,
          };
          return;
        }
      }
    };
    fallback("waybillNo", /[A-Z]{2}\d{10}/, normalizeWaybillNo);
    fallback("date", /\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/, normalizeDate);
    fallback("weight", /\d+(?:\.\d+)?(?:KG|公斤|千克)/, normalizeWeight);

    fields._meanConfidence = confN ? Math.round(confSum / confN) : 0;
    return fields;
  }

  /** 队列分类：{ blurry, missing: [fieldKey...], badFormat } */
  function classify(fields, lapVar) {
    const missing = FIELDS.filter((k) => !fields[k].value);
    const badFormat = !!fields.waybillNo.value && !WAYBILL_RE.test(normalizeWaybillNo(fields.waybillNo.value));
    const blurry =
      (typeof lapVar === "number" && lapVar < BLUR_LAPVAR_THRESHOLD) ||
      (fields._meanConfidence || 0) < BLUR_OCR_CONF_THRESHOLD;
    return { blurry, missing, badFormat };
  }

  /** 记录级置信分：取各字段置信度最低值（最薄弱环节），缺失字段为 0 */
  function recordScore(fields) {
    let score = 1;
    for (const key of FIELDS) {
      let c = fields[key].value ? fields[key].confidence : 0;
      if (key === "waybillNo" && fields[key].value && !WAYBILL_RE.test(normalizeWaybillNo(fields[key].value))) {
        c *= 0.4;
      }
      score = Math.min(score, c);
    }
    return Math.round(score * 100) / 100;
  }

  /**
   * 重复/修订判定。
   * 单号相同且重量、日期一致 → duplicate（重复件）；单号相同但重量或日期不同 → revision（修订件，不丢弃）。
   */
  function detectDuplicate(newFields, existing) {
    const norm = normalizeWaybillNo(newFields.waybillNo.value);
    if (!norm) return null;
    const same = existing.filter(
      (r) => r.status !== "duplicate" && normalizeWaybillNo(r.fields.waybillNo.value) === norm
    );
    if (!same.length) return null;
    const w = normalizeWeight(newFields.weight.value);
    const d = normalizeDate(newFields.date.value);
    const identical = same.find(
      (r) => normalizeWeight(r.fields.weight.value) === w && normalizeDate(r.fields.date.value) === d
    );
    if (identical) return { type: "duplicate", of: identical.id };
    return { type: "revision", of: same[same.length - 1].id };
  }

  return {
    FIELDS,
    FIELD_LABELS,
    WAYBILL_RE,
    BLUR_LAPVAR_THRESHOLD,
    normalizeLines,
    extractFields,
    classify,
    recordScore,
    detectDuplicate,
    normalizeWaybillNo,
    normalizeDate,
    normalizeWeight,
  };
});
