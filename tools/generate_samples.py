#!/usr/bin/env python3
"""生成虚构运单扫描样本图片（多种版式 + 各类异常件），输出到 samples/。

仅使用 Pillow。字体来自 npm 包 @expo-google-fonts/noto-sans-sc。
同时为每张图计算 Laplacian 方差（模糊度指标），写入 manifest.json 供前端阈值校准。
"""
import json
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "node_modules", "@expo-google-fonts", "noto-sans-sc")
OUT_DIR = os.path.join(ROOT, "samples")

W, H = 1000, 620


def font(weight, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, weight), size)


def f_reg(size):
    return font(os.path.join("400Regular", "NotoSansSC_400Regular.ttf"), size)


def f_bold(size):
    return font(os.path.join("700Bold", "NotoSansSC_700Bold.ttf"), size)


def draw_barcode(draw, x, y, w, h, seed):
    rnd = random.Random(seed)
    cx = x
    while cx < x + w:
        bw = rnd.choice([2, 2, 3, 4, 6])
        if rnd.random() < 0.62:
            draw.rectangle([cx, y, cx + bw, y + h], fill=(20, 20, 20))
        cx += bw + rnd.choice([2, 3, 4])


def base_canvas():
    img = Image.new("RGB", (W, H), (252, 252, 250))
    d = ImageDraw.Draw(img)
    d.rectangle([8, 8, W - 9, H - 9], outline=(60, 60, 60), width=3)
    return img, d


def layout_a(data, y_shift=0):
    """版式A：迅达快递 —— 标准快递面单，标签：运单号/发货地/目的地/重量/日期"""
    img, d = base_canvas()
    y0 = 30 + y_shift
    d.rectangle([30, y0, 220, y0 + 64], fill=(200, 30, 30))
    d.text((52, y0 + 10), "迅达", font=f_bold(40), fill=(255, 255, 255))
    d.text((240, y0 + 8), "迅达快递 XUNDA EXPRESS", font=f_bold(34), fill=(30, 30, 30))
    d.text((240, y0 + 52), "全国服务热线 955-XX", font=f_reg(20), fill=(120, 120, 120))

    draw_barcode(d, 620, y0 + 4, 330, 56, seed=data["waybillNo"])
    d.text((660, y0 + 64), data["waybillNo"], font=f_reg(24), fill=(30, 30, 30))

    rows = [
        ("运单号", data["waybillNo"]),
        ("发货地", data["origin"]),
        ("目的地", data["destination"]),
        ("重量", f"{data['weight']} kg"),
        ("日期", data["date"]),
    ]
    ty = y0 + 110
    for label, value in rows:
        d.line([(40, ty), (W - 40, ty)], fill=(180, 180, 180), width=2)
        d.text((60, ty + 16), label, font=f_bold(30), fill=(40, 40, 40))
        d.text((260, ty + 16), value, font=f_reg(32), fill=(10, 10, 10))
        ty += 72
    d.line([(40, ty), (W - 40, ty)], fill=(180, 180, 180), width=2)
    d.text((60, ty + 14), "请核对收件信息，签收前验视外包装。", font=f_reg(20), fill=(140, 140, 140))
    return img


def layout_b(data, y_shift=0):
    """版式B：安捷物流 —— 双列表格，标签：单号/始发地/到达地/重量/日期"""
    img, d = base_canvas()
    y0 = 26 + y_shift
    d.ellipse([36, y0, 100, y0 + 64], outline=(20, 60, 160), width=5)
    d.text((120, y0 + 6), "安捷物流", font=f_bold(38), fill=(20, 60, 160))
    d.text((120, y0 + 52), "ANJIE LOGISTICS · 货运专线", font=f_reg(20), fill=(110, 110, 110))
    d.text((600, y0 + 16), "货运单", font=f_bold(30), fill=(30, 30, 30))

    top = y0 + 100
    left_labels = [("单  号", data["waybillNo"]), ("始发地", data["origin"]), ("到达地", data["destination"])]
    right_rows = [("重  量", f"{data['weight']}KG"), ("日  期", data["date"].replace("-", "/"))]
    d.rectangle([40, top, W - 40, top + 330], outline=(90, 90, 90), width=2)
    d.line([(500, top), (500, top + 330)], fill=(90, 90, 90), width=2)
    for i in (1, 2):
        d.line([(40, top + i * 110), (W - 40, top + i * 110)], fill=(90, 90, 90), width=2)
    for i, (label, value) in enumerate(left_labels):
        ry = top + i * 110
        d.text((60, ry + 34), label, font=f_bold(28), fill=(60, 60, 60))
        d.text((210, ry + 32), value, font=f_reg(32), fill=(10, 10, 10))
    for i, (label, value) in enumerate(right_rows):
        ry = top + i * 110
        d.text((520, ry + 34), label, font=f_bold(28), fill=(60, 60, 60))
        d.text((680, ry + 32), value, font=f_reg(32), fill=(10, 10, 10))
    d.text((520, top + 2 * 110 + 34), "备  注", font=f_bold(28), fill=(60, 60, 60))
    d.text((680, top + 2 * 110 + 32), "送货上门", font=f_reg(28), fill=(10, 10, 10))
    d.text((60, top + 350), "客服电话：400-XXX-XXXX    官网：www.anjie-example.cn", font=f_reg(20), fill=(140, 140, 140))
    return img


def layout_c(data, y_shift=0):
    """版式C：环宇货运 —— 中英双语标签：WAYBILL NO/FROM/TO/WEIGHT/DATE"""
    img, d = base_canvas()
    y0 = 28 + y_shift
    d.rectangle([30, y0, W - 30, y0 + 70], fill=(25, 90, 70))
    d.text((50, y0 + 12), "环宇货运 HUANYU FREIGHT", font=f_bold(34), fill=(255, 255, 255))
    d.text((700, y0 + 18), "运单 WAYBILL", font=f_bold(28), fill=(230, 240, 235))

    rows = [
        ("运单号 WAYBILL NO.", data["waybillNo"]),
        ("发货地 FROM", data["origin"]),
        ("目的地 TO", data["destination"]),
        ("重量 WEIGHT", f"{data['weight']} 公斤"),
        ("日期 DATE", data["date"]),
    ]
    ty = y0 + 96
    for label, value in rows:
        d.text((60, ty + 12), label, font=f_bold(27), fill=(50, 50, 50))
        d.rectangle([360, ty, W - 60, ty + 58], outline=(150, 150, 150), width=2)
        d.text((380, ty + 10), value, font=f_reg(30), fill=(10, 10, 10))
        ty += 76
    d.text((60, ty + 8), "此联为寄件人存根 · SENDER COPY", font=f_reg(20), fill=(140, 140, 140))
    return img


def laplacian_variance(img):
    """灰度图 Laplacian 方差，越小越模糊。下采样到宽 400 以与前端一致。"""
    g = img.convert("L")
    ratio = 400 / g.width
    g = g.resize((400, max(1, int(g.height * ratio))))
    px = g.load()
    w, h = g.size
    vals = []
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            lap = 4 * px[x, y] - px[x - 1, y] - px[x + 1, y] - px[x, y - 1] - px[x, y + 1]
            vals.append(lap)
    mean = sum(vals) / len(vals)
    return sum((v - mean) ** 2 for v in vals) / len(vals)


def save(img, name):
    path = os.path.join(OUT_DIR, name)
    img.save(path, "JPEG", quality=75)
    return path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    samples = []

    def add(name, layout_fn, data, tags, expect, transform=None, y_shift=0):
        img = layout_fn(data, y_shift=y_shift)
        if transform:
            img = transform(img)
        lv = laplacian_variance(img)
        save(img, name)
        samples.append({
            "file": name, "tags": tags, "expect": expect,
            "laplacianVar": round(lv, 1),
        })
        print(f"{name}: lapVar={lv:.1f}")

    d1 = {"waybillNo": "YD8801234567", "origin": "上海市浦东新区", "destination": "北京市海淀区",
          "weight": "12.5", "date": "2026-11-10"}
    add("01-xunda-clean.jpg", layout_a, d1, ["clean"],
        {"waybillNo": "YD8801234567", "origin": "上海市浦东新区", "destination": "北京市海淀区",
         "weight": "12.5", "date": "2026-11-10"})

    d2 = {"waybillNo": "AJ6612045381", "origin": "广州市天河区", "destination": "成都市武侯区",
          "weight": "8.2", "date": "2026-11-09"}
    add("02-anjie-clean.jpg", layout_b, d2, ["clean"],
        {"waybillNo": "AJ6612045381", "origin": "广州市天河区", "destination": "成都市武侯区",
         "weight": "8.2", "date": "2026-11-09"})

    d3 = {"waybillNo": "HY5508734210", "origin": "深圳市南山区", "destination": "杭州市西湖区",
          "weight": "23.0", "date": "2026-11-08"}
    add("03-huanyu-clean.jpg", layout_c, d3, ["clean"],
        {"waybillNo": "HY5508734210", "origin": "深圳市南山区", "destination": "杭州市西湖区",
         "weight": "23.0", "date": "2026-11-08"})

    # 重复件：与 01 完全相同的运单数据，重新扫描（轻微位移）
    add("04-xunda-duplicate.jpg", layout_a, d1, ["duplicate_of:YD8801234567"],
        dict(samples[0]["expect"]), y_shift=6)

    # 修订件：与 02 同单号，重量不同（8.2 -> 9.6），不能当重复件丢弃
    d5 = dict(d2, weight="9.6")
    add("05-anjie-revision.jpg", layout_b, d5, ["revision_of:AJ6612045381"],
        {"waybillNo": "AJ6612045381", "origin": "广州市天河区", "destination": "成都市武侯区",
         "weight": "9.6", "date": "2026-11-09"})

    # 模糊件
    d6 = {"waybillNo": "YD8809999123", "origin": "南京市鼓楼区", "destination": "武汉市江汉区",
          "weight": "3.7", "date": "2026-11-11"}

    def blur(t):
        t = t.resize((740, 458))
        return t.filter(ImageFilter.GaussianBlur(1.5))

    add("06-xunda-blurry.jpg", layout_a, d6, ["blurry"],
        {"waybillNo": "YD8809999123", "origin": "南京市鼓楼区", "destination": "武汉市江汉区",
         "weight": "3.7", "date": "2026-11-11"}, transform=blur)

    # 缺字段件：无重量行 —— 用自定义绘制（版式B去掉重量）
    d7 = {"waybillNo": "AJ6612000111", "origin": "苏州市姑苏区", "destination": "重庆市渝中区",
          "weight": "", "date": "2026-11-07"}

    def layout_b_missing(data, y_shift=0):
        img, d = base_canvas()
        y0 = 26
        d.ellipse([36, y0, 100, y0 + 64], outline=(20, 60, 160), width=5)
        d.text((120, y0 + 6), "安捷物流", font=f_bold(38), fill=(20, 60, 160))
        d.text((600, y0 + 16), "货运单", font=f_bold(30), fill=(30, 30, 30))
        top = y0 + 100
        d.rectangle([40, top, W - 40, top + 330], outline=(90, 90, 90), width=2)
        d.line([(500, top), (500, top + 330)], fill=(90, 90, 90), width=2)
        for i in (1, 2):
            d.line([(40, top + i * 110), (W - 40, top + i * 110)], fill=(90, 90, 90), width=2)
        rows = [("单  号", data["waybillNo"]), ("始发地", data["origin"]), ("到达地", data["destination"])]
        for i, (label, value) in enumerate(rows):
            ry = top + i * 110
            d.text((60, ry + 34), label, font=f_bold(28), fill=(60, 60, 60))
            d.text((210, ry + 32), value, font=f_reg(32), fill=(10, 10, 10))
        d.text((520, top + 110 + 34), "日  期", font=f_bold(28), fill=(60, 60, 60))
        d.text((680, top + 110 + 32), data["date"].replace("-", "/"), font=f_reg(32), fill=(10, 10, 10))
        return img

    add("07-anjie-missing-weight.jpg", layout_b_missing, d7, ["missing:weight"],
        {"waybillNo": "AJ6612000111", "origin": "苏州市姑苏区", "destination": "重庆市渝中区",
         "weight": "", "date": "2026-11-07"})

    # 编号格式错误件：单号不符合 2字母+10数字 规则
    d8 = {"waybillNo": "HY55-08X421", "origin": "长沙市岳麓区", "destination": "天津市和平区",
          "weight": "15.4", "date": "2026-11-06"}
    add("08-huanyu-badformat.jpg", layout_c, d8, ["bad_format"],
        {"waybillNo": "HY55-08X421", "origin": "长沙市岳麓区", "destination": "天津市和平区",
         "weight": "15.4", "date": "2026-11-06"})

    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(samples, f, ensure_ascii=False, indent=2)
    print(f"\n共生成 {len(samples)} 张样本 -> {OUT_DIR}")


if __name__ == "__main__":
    main()
