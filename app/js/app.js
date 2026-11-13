/* 运单影像收件台 —— 主界面逻辑 */
(function () {
  "use strict";
  const EX = window.WaybillExtract;
  const OCR = window.WaybillOCR;
  const Store = window.WaybillStore;

  const QUEUES = [
    { key: "pending", label: "待复核" },
    { key: "blurry", label: "模糊图像" },
    { key: "missing", label: "字段缺失" },
    { key: "badformat", label: "格式错误" },
    { key: "revision", label: "修订件" },
    { key: "duplicate", label: "重复件" },
    { key: "confirmed", label: "已确认" },
  ];

  const state = Store.load();
  let currentQueue = "pending";
  let selectedId = null;
  let activeField = null;

  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-");
  const nowIso = () => new Date().toISOString();
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  function persist() {
    Store.save(state);
  }

  function findRecord(id) {
    return state.records.find((r) => r.id === id);
  }

  function addHistory(rec, action, detail) {
    rec.history.push({ ts: nowIso(), action, detail: detail || "" });
  }

  // ---------- 收件流水线 ----------
  async function ingestImage(dataUrl, fileName) {
    const img = await OCR.loadImage(dataUrl);
    const lapVar = Math.round(OCR.laplacianVariance(img) * 10) / 10;
    const { lines } = await OCR.recognize(img);
    const fields = EX.extractFields(lines);
    const flags = EX.classify(fields, lapVar);
    const score = EX.recordScore(fields);

    const rec = {
      id: "WB-" + String(state.seq++).padStart(4, "0"),
      fileName,
      imageDataUrl: dataUrl,
      importedAt: nowIso(),
      status: "pending",
      flags: { blurry: flags.blurry, missing: flags.missing, badFormat: flags.badFormat, revisionOf: null },
      duplicateOf: null,
      fields: {},
      score,
      ocrMean: fields._meanConfidence,
      lapVar,
      history: [],
      confirmedAt: null,
    };
    for (const key of EX.FIELDS) {
      const f = fields[key];
      rec.fields[key] = {
        ocr: f.value,
        value: f.value,
        confidence: f.confidence,
        bbox: f.bbox,
        edited: false,
        editedAt: null,
      };
    }

    // 重复 / 修订判定（与全部历史记录比对）
    const dup = EX.detectDuplicate(fields, state.records);
    if (dup && dup.type === "duplicate") {
      rec.status = "duplicate";
      rec.duplicateOf = dup.of;
      addHistory(rec, "自动判重", `与 ${dup.of} 单号、重量、日期一致，归入重复件`);
    } else if (dup && dup.type === "revision") {
      rec.flags.revisionOf = dup.of;
      addHistory(rec, "修订件", `与 ${dup.of} 单号相同，但重量或日期不同，按新运单保留`);
    }
    if (flags.blurry) addHistory(rec, "模糊图像", `清晰度 ${lapVar}，低于阈值 ${EX.BLUR_LAPVAR_THRESHOLD}`);
    if (flags.missing.length)
      addHistory(rec, "字段缺失", flags.missing.map((k) => EX.FIELD_LABELS[k]).join("、"));
    if (flags.badFormat) addHistory(rec, "格式错误", `运单号「${rec.fields.waybillNo.value}」不符合编号规则`);
    addHistory(rec, "收件识别", `来源 ${fileName}，综合置信分 ${score}`);

    state.records.push(rec);
    persist();
    return rec;
  }

  // ---------- 队列与列表 ----------
  function queueRecords(key) {
    const pending = state.records.filter((r) => r.status === "pending");
    switch (key) {
      case "pending":
        return pending.slice().sort((a, b) => a.score - b.score || a.importedAt.localeCompare(b.importedAt));
      case "blurry":
        return pending.filter((r) => r.flags.blurry);
      case "missing":
        return pending.filter((r) => r.flags.missing.length);
      case "badformat":
        return pending.filter((r) => r.flags.badFormat);
      case "revision":
        return pending.filter((r) => r.flags.revisionOf);
      case "duplicate":
        return state.records.filter((r) => r.status === "duplicate");
      case "confirmed":
        return state.records.filter((r) => r.status === "confirmed");
      default:
        return [];
    }
  }

  function badges(rec) {
    const out = [];
    if (rec.status === "confirmed") out.push('<span class="badge confirmed">已确认</span>');
    if (rec.status === "duplicate") out.push('<span class="badge duplicate">重复件</span>');
    if (rec.flags.blurry) out.push('<span class="badge blurry">模糊</span>');
    if (rec.flags.missing.length)
      out.push(`<span class="badge missing">缺:${rec.flags.missing.map((k) => EX.FIELD_LABELS[k]).join("/")}</span>`);
    if (rec.flags.badFormat) out.push('<span class="badge badformat">格式错误</span>');
    if (rec.flags.revisionOf) out.push('<span class="badge revision">修订件</span>');
    return out.join("");
  }

  function scoreColor(s) {
    if (s < 0.5) return "#d64545";
    if (s < 0.8) return "#e0a13c";
    return "#1a9e6b";
  }

  function renderTabs() {
    $("queueTabs").innerHTML = QUEUES.map((q) => {
      const n = queueRecords(q.key).length;
      return `<button class="queue-tab ${q.key === currentQueue ? "active" : ""}" data-queue="${q.key}">${q.label}<span class="count">${n}</span></button>`;
    }).join("");
  }

  function renderList() {
    const recs = queueRecords(currentQueue);
    const el = $("recordList");
    if (!recs.length) {
      el.innerHTML = '<p class="muted" style="padding:12px">该队列暂无记录</p>';
      return;
    }
    el.innerHTML = recs
      .map((r) => {
        const no = r.fields.waybillNo.value;
        const pct = Math.round(r.score * 100);
        return `<div class="record-card ${r.id === selectedId ? "active" : ""}" data-id="${r.id}">
          <div class="line1">
            <span class="waybill ${no ? "" : "unrecognized"}">${esc(no || "（未识别单号）")}</span>
            <span class="muted" style="font-size:11px">${r.id}</span>
          </div>
          <div class="file">${esc(r.fileName)} · ${fmtTime(r.importedAt)}</div>
          <div class="badges">${badges(r)}</div>
          <div class="score-bar"><div class="score-fill" style="width:${pct}%;background:${scoreColor(r.score)}"></div></div>
          <div class="score-label">综合置信分 ${pct}%（按最低字段置信度计）</div>
        </div>`;
      })
      .join("");
  }

  // ---------- 详情 ----------
  function confChip(f) {
    if (!f.value) return '<span class="conf-chip none">缺失</span>';
    const pct = Math.round(f.confidence * 100);
    if (f.confidence >= 0.85) return `<span class="conf-chip high">置信 ${pct}%</span>`;
    if (f.confidence >= 0.6) return `<span class="conf-chip mid">置信 ${pct}%</span>`;
    return `<span class="conf-chip low">置信 ${pct}%</span>`;
  }

  function renderDetail() {
    const rec = findRecord(selectedId);
    $("emptyState").classList.toggle("hidden", !!rec);
    $("detailContent").classList.toggle("hidden", !rec);
    if (!rec) return;

    $("detailHeader").innerHTML = `
      <h2>${esc(rec.fields.waybillNo.value || "（未识别单号）")}</h2>
      <div class="badges">${badges(rec)}</div>
      <span class="meta">${rec.id} · ${esc(rec.fileName)} · 收件 ${fmtTime(rec.importedAt)}</span>`;

    // 提示条
    const dupBanner = $("dupBanner");
    const warnBanner = $("warnBanner");
    dupBanner.classList.add("hidden");
    warnBanner.classList.add("hidden");
    if (rec.status === "duplicate" && rec.duplicateOf) {
      const src = findRecord(rec.duplicateOf);
      dupBanner.innerHTML = `<b>重复扫描件</b>：与记录 ${esc(rec.duplicateOf)}${
        src ? `（${esc(src.fields.waybillNo.value)}）` : ""
      } 的单号、重量、日期完全一致，已自动归入重复件队列，不参与复核。如需保留可点击「恢复为待复核」。`;
      dupBanner.classList.remove("hidden");
    } else {
      const warns = [];
      if (rec.flags.revisionOf)
        warns.push(`<b>修订件</b>：与记录 ${esc(rec.flags.revisionOf)} 单号相同，但重量或日期不同——已按新运单保留，请重点核对差异字段。`);
      if (rec.flags.blurry) warns.push(`<b>图像模糊</b>（清晰度 ${rec.lapVar}），识别结果可能不可靠。`);
      if (rec.flags.badFormat) warns.push(`<b>格式错误</b>：运单号不符合编号规则（2 位字母 + 10 位数字），请核对。`);
      if (rec.flags.missing.length)
        warns.push(`<b>字段缺失</b>：${rec.flags.missing.map((k) => EX.FIELD_LABELS[k]).join("、")}，请对照原图补录。`);
      if (warns.length) {
        warnBanner.innerHTML = warns.join("<br>");
        warnBanner.classList.remove("hidden");
      }
    }

    // 原图与字段定位框
    const img = $("recordImage");
    img.onload = () => renderOverlays(rec);
    img.src = rec.imageDataUrl;
    if (img.complete && img.naturalWidth) renderOverlays(rec); // 缓存命中时 onload 不一定触发
    $("imageMeta").textContent =
      `图像清晰度(Laplacian 方差) ${rec.lapVar} · OCR 平均置信 ${rec.ocrMean}% · 综合置信分 ${Math.round(rec.score * 100)}%`;

    // 字段表单
    $("fieldForm").innerHTML = EX.FIELDS.map((key) => {
      const f = rec.fields[key];
      const meta = [];
      if (f.edited) {
        meta.push(`识别原值：<span class="ocr-orig">${esc(f.ocr || "（空）")}</span>`);
        meta.push(`修改时间：${fmtTime(f.editedAt)}`);
      }
      return `<div class="field-row ${key === activeField ? "active" : ""}" data-field="${key}">
        <div class="field-head">
          <span class="field-name">${EX.FIELD_LABELS[key]}</span>
          ${confChip(f)}
          ${f.edited ? '<span class="conf-chip mid">已人工修正</span>' : ""}
        </div>
        <input type="text" data-field-input="${key}" value="${esc(f.value)}"
               class="${f.edited ? "edited" : ""}" placeholder="（对照左侧原图填写）">
        ${meta.length ? `<div class="field-meta">${meta.join(" · ")}</div>` : ""}
      </div>`;
    }).join("");

    // 操作按钮
    $("btnConfirm").classList.toggle("hidden", rec.status === "confirmed");
    $("btnConfirm").disabled = rec.status === "duplicate";
    $("btnUnconfirm").classList.toggle("hidden", rec.status !== "confirmed");
    $("btnRestore").classList.toggle("hidden", rec.status !== "duplicate");

    // 处理记录
    $("historyList").innerHTML = rec.history
      .slice()
      .reverse()
      .map((h) => `<li><b>${esc(h.action)}</b> ${esc(h.detail)}<br><span>${fmtTime(h.ts)}</span></li>`)
      .join("");
    if (rec.confirmedAt) {
      $("historyList").insertAdjacentHTML(
        "afterbegin",
        `<li><b>已确认</b> 结构化运单记录生成时间 ${fmtTime(rec.confirmedAt)}</li>`
      );
    }
  }

  function renderOverlays(rec) {
    const img = $("recordImage");
    const layer = $("overlayLayer");
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    layer.innerHTML = "";
    for (const key of EX.FIELDS) {
      const f = rec.fields[key];
      if (!f.bbox) continue;
      const box = document.createElement("div");
      box.className = "field-box" + (key === activeField ? " active" : "");
      box.dataset.field = key;
      box.style.left = (f.bbox.x0 / nw) * 100 + "%";
      box.style.top = (f.bbox.y0 / nh) * 100 + "%";
      box.style.width = ((f.bbox.x1 - f.bbox.x0) / nw) * 100 + "%";
      box.style.height = ((f.bbox.y1 - f.bbox.y0) / nh) * 100 + "%";
      box.innerHTML = `<span class="box-label">${EX.FIELD_LABELS[key]}</span>`;
      box.title = `${EX.FIELD_LABELS[key]}：${f.value || "（空）"}`;
      layer.appendChild(box);
    }
  }

  function setActiveField(key, scroll) {
    activeField = key;
    document.querySelectorAll(".field-row").forEach((el) =>
      el.classList.toggle("active", el.dataset.field === key)
    );
    document.querySelectorAll(".field-box").forEach((el) =>
      el.classList.toggle("active", el.dataset.field === key)
    );
    if (scroll) {
      const box = document.querySelector(`.field-box[data-field="${key}"]`);
      if (box) box.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // ---------- 事件 ----------
  function bindEvents() {
    $("queueTabs").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-queue]");
      if (!btn) return;
      currentQueue = btn.dataset.queue;
      renderTabs();
      renderList();
    });

    $("recordList").addEventListener("click", (e) => {
      const card = e.target.closest("[data-id]");
      if (!card) return;
      selectedId = card.dataset.id;
      activeField = null;
      renderList();
      renderDetail();
    });

    // 字段行 / 定位框 联动
    $("fieldForm").addEventListener("focusin", (e) => {
      const input = e.target.closest("[data-field-input]");
      if (input) setActiveField(input.dataset.fieldInput, true);
    });
    $("fieldForm").addEventListener("click", (e) => {
      const row = e.target.closest("[data-field]");
      if (row) setActiveField(row.dataset.field, true);
    });
    $("overlayLayer").addEventListener("click", (e) => {
      const box = e.target.closest("[data-field]");
      if (!box) return;
      setActiveField(box.dataset.field, false);
      const input = document.querySelector(`[data-field-input="${box.dataset.field}"]`);
      if (input) input.focus();
    });

    // 字段修改：保留识别原值，记录人工值与修改时间
    $("fieldForm").addEventListener("input", (e) => {
      const input = e.target.closest("[data-field-input]");
      if (!input) return;
      const rec = findRecord(selectedId);
      if (!rec) return;
      const key = input.dataset.fieldInput;
      const f = rec.fields[key];
      f.value = input.value.trim();
      f.edited = f.value !== f.ocr;
      if (f.edited) f.editedAt = nowIso();
      else f.editedAt = null;
      input.classList.toggle("edited", f.edited);
      persist();
    });

    $("btnConfirm").addEventListener("click", () => {
      const rec = findRecord(selectedId);
      if (!rec || rec.status === "duplicate") return;
      const no = rec.fields.waybillNo.value;
      if (!EX.WAYBILL_RE.test(EX.normalizeWaybillNo(no))) {
        if (!confirm(`运单号「${no || "（空）"}」不符合编号规则（2 位字母 + 10 位数字），仍要确认吗？`)) return;
      }
      const editedKeys = EX.FIELDS.filter((k) => rec.fields[k].edited);
      for (const k of editedKeys) {
        addHistory(rec, "人工修正", `${EX.FIELD_LABELS[k]}：「${rec.fields[k].ocr || "（空）"}」→「${rec.fields[k].value}」`);
      }
      rec.status = "confirmed";
      rec.confirmedAt = nowIso();
      addHistory(rec, "确认", "生成结构化运单记录");
      persist();
      renderTabs();
      renderList();
      renderDetail();
    });

    $("btnUnconfirm").addEventListener("click", () => {
      const rec = findRecord(selectedId);
      if (!rec) return;
      rec.status = "pending";
      rec.confirmedAt = null;
      addHistory(rec, "撤销确认", "退回待复核队列");
      persist();
      renderTabs();
      renderList();
      renderDetail();
    });

    $("btnRestore").addEventListener("click", () => {
      const rec = findRecord(selectedId);
      if (!rec) return;
      addHistory(rec, "人工恢复", `从重复件恢复（原判与 ${rec.duplicateOf} 重复）`);
      rec.status = "pending";
      rec.duplicateOf = null;
      persist();
      renderTabs();
      renderList();
      renderDetail();
    });

    $("btnDelete").addEventListener("click", () => {
      const rec = findRecord(selectedId);
      if (!rec) return;
      if (!confirm(`确定删除记录 ${rec.id}（${rec.fileName}）吗？`)) return;
      state.records = state.records.filter((r) => r.id !== rec.id);
      selectedId = null;
      persist();
      renderTabs();
      renderList();
      renderDetail();
    });

    $("btnImport").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (files.length) await importFiles(files);
    });

    $("btnDemo").addEventListener("click", loadDemoSamples);

    $("btnExport").addEventListener("click", exportJson);

    $("btnClear").addEventListener("click", () => {
      if (!confirm("确定清空全部记录吗？（不可恢复）")) return;
      Store.clear();
      state.records = [];
      state.seq = 1;
      selectedId = null;
      renderTabs();
      renderList();
      renderDetail();
    });
  }

  // ---------- 导入 ----------
  function setProgress(text, ratio) {
    $("progressWrap").classList.remove("hidden");
    $("progressText").textContent = text;
    $("progressFill").style.width = Math.round((ratio || 0) * 100) + "%";
  }
  function hideProgress() {
    $("progressWrap").classList.add("hidden");
  }

  async function importFiles(items) {
    // items: [{name, getDataUrl}] 或 File 数组
    let done = 0;
    for (const item of items) {
      const name = item.name || item.fileName || "未命名";
      try {
        setProgress(`识别中 ${done + 1}/${items.length}：${name}`, done / items.length);
        const dataUrl = item instanceof File ? await OCR.fileToDataUrl(item) : await item.getDataUrl();
        const rec = await ingestImage(dataUrl, name);
        selectedId = rec.id;
      } catch (err) {
        console.error(err);
        alert(`处理 ${name} 失败：${err.message}`);
      }
      done++;
    }
    hideProgress();
    renderTabs();
    renderList();
    renderDetail();
  }

  async function loadDemoSamples() {
    try {
      setProgress("正在读取演示样本清单…", 0);
      const manifest = await (await fetch("../samples/manifest.json")).json();
      const items = manifest.map((s) => ({
        name: s.file,
        getDataUrl: async () => {
          const blob = await (await fetch("../samples/" + s.file)).blob();
          return OCR.fileToDataUrl(blob);
        },
      }));
      await importFiles(items);
    } catch (err) {
      hideProgress();
      alert("载入演示样本失败：" + err.message + "\n请确认通过本地 HTTP 服务访问（见 README）。");
    }
  }

  // ---------- 导出 ----------
  function exportJson() {
    const out = state.records.map((r) => {
      const rec = {
        记录号: r.id,
        状态: { pending: "待复核", confirmed: "已确认", duplicate: "重复件" }[r.status],
        运单号: r.fields.waybillNo.value,
        发货地: r.fields.origin.value,
        目的地: r.fields.destination.value,
        重量: r.fields.weight.value,
        日期: r.fields.date.value,
        来源文件: r.fileName,
        收件时间: r.importedAt,
        确认时间: r.confirmedAt,
        队列标记: {
          模糊: r.flags.blurry,
          缺失字段: r.flags.missing.map((k) => EX.FIELD_LABELS[k]),
          格式错误: r.flags.badFormat,
          修订自: r.flags.revisionOf,
          重复于: r.duplicateOf,
        },
        字段审计: Object.fromEntries(
          EX.FIELDS.map((k) => [
            EX.FIELD_LABELS[k],
            {
              识别原值: r.fields[k].ocr,
              最终值: r.fields[k].value,
              置信度: r.fields[k].confidence,
              人工修改: r.fields[k].edited,
              修改时间: r.fields[k].editedAt,
            },
          ])
        ),
        处理记录: r.history,
      };
      return rec;
    });
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    a.href = URL.createObjectURL(blob);
    a.download = `运单记录-${ts}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 启动 ----------
  bindEvents();
  renderTabs();
  renderList();
  renderDetail();
})();
