#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成红果短剧套件图标（DSM PACKAGE_ICON + 门户 ui/images）。

用法: python nas/make-icons.py
输出: nas/assets/PACKAGE_ICON.PNG（72x72）、PACKAGE_ICON_256.PNG（256x256）、
      nas/assets/ui/images/icon_{16,24,32,48,64,72,128,256}.png
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
UI_IMG = os.path.join(ASSETS, "ui", "images")
os.makedirs(UI_IMG, exist_ok=True)

MASTER = 1024
RED_TOP = (233, 45, 58)
RED_BOT = (196, 24, 38)
WHITE = (255, 255, 255)


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = 200
    # 垂直渐变圆角底
    grad = Image.new("RGB", (MASTER, MASTER), RED_TOP)
    gd = ImageDraw.Draw(grad)
    for y in range(MASTER):
        t = y / (MASTER - 1)
        gd.line([(0, y), (MASTER, y)], fill=(
            int(RED_TOP[0] + (RED_BOT[0] - RED_TOP[0]) * t),
            int(RED_TOP[1] + (RED_BOT[1] - RED_TOP[1]) * t),
            int(RED_TOP[2] + (RED_BOT[2] - RED_TOP[2]) * t),
        ))
    mask = Image.new("L", (MASTER, MASTER), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, MASTER - 1, MASTER - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)

    # 白色播放三角（居中偏右，光学居中）
    w = 300
    h = 360
    cx, cy = 545, MASTER // 2
    d.polygon([(cx - w // 2, cy - h // 2), (cx - w // 2, cy + h // 2), (cx + w // 2, cy)], fill=WHITE)

    # 顶部小字「红果」（仅大图可读）
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 150)
    except Exception:
        try:
            font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 150)
        except Exception:
            font = None
    if font is not None:
        txt = "红果"
        box = d.textbbox((0, 0), txt, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        d.text(((MASTER - tw) / 2 - box[0], 120 - box[1]), txt, font=font, fill=WHITE)
    return img


def main() -> None:
    master = draw_master()
    sizes = [16, 24, 32, 48, 64, 72, 128, 256]
    for s in sizes:
        out = master.resize((s, s), Image.LANCZOS)
        out.save(os.path.join(UI_IMG, f"icon_{s}.png"), "PNG", optimize=True)
    master.resize((72, 72), Image.LANCZOS).save(os.path.join(ASSETS, "PACKAGE_ICON.PNG"), "PNG", optimize=True)
    master.resize((256, 256), Image.LANCZOS).save(os.path.join(ASSETS, "PACKAGE_ICON_256.PNG"), "PNG", optimize=True)
    print("图标已生成:")
    for s in sizes:
        p = os.path.join(UI_IMG, f"icon_{s}.png")
        print(f"  {p}  {os.path.getsize(p)} bytes")


if __name__ == "__main__":
    main()
