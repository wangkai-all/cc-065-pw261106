/* 本地持久化：记录保存在 localStorage，图片以 dataURL 形式随记录存储，不离开本机 */
(function (root) {
  "use strict";
  const KEY = "waybill-desk-v1";

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { records: [], seq: 1 };
      const data = JSON.parse(raw);
      return { records: data.records || [], seq: data.seq || 1 };
    } catch (e) {
      console.error("读取本地数据失败", e);
      return { records: [], seq: 1 };
    }
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      alert("保存失败：浏览器本地存储空间不足（图片过大）。可删除部分记录或导出的 JSON 后清空。");
      console.error(e);
      return false;
    }
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  root.WaybillStore = { load, save, clear };
})(window);
