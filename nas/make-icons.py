#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从项目自己的 logo 生成套件图标（DSM PACKAGE_ICON + 门户 ui/images）。

源图：web/assets/logo.png（项目自带，40x40，橙绿渐变 + 白色播放三角）
产物：nas/assets/PACKAGE_ICON.PNG（72x72）、PACKAGE_ICON_256.PNG（256x256）、
      nas/assets/ui/images/icon_{16,24,32,48,64,72,128,256}.png

用法: python nas/make-icons.py
"""
import os

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "web", "assets", "logo.png")
ASSETS = os.path.join(HERE, "assets")
UI_IMG = os.path.join(ASSETS, "ui", "images")
SIZES = [16, 24, 32, 48, 64, 72, 128, 256]
MASTER = 1024


def load_master() -> Image.Image:
    """读项目 logo → 居中补成正方形 → 放大到 1024 → 轻锐化补偿放大模糊。"""
    src = Image.open(SRC).convert("RGBA")
    w, h = src.size
    s = max(w, h)
    square = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    square.paste(src, ((s - w) // 2, (s - h) // 2))
    master = square.resize((MASTER, MASTER), Image.LANCZOS)
    # 40px → 1024px 放大必然变软，轻度 USM 让边缘/三角更实
    master = master.filter(ImageFilter.UnsharpMask(radius=2.5, percent=90, threshold=2))
    return master


def main() -> None:
    if not os.path.exists(SRC):
        raise SystemExit(f"[!] 找不到项目 logo: {SRC}")
    os.makedirs(UI_IMG, exist_ok=True)
    master = load_master()

    for size in SIZES:
        master.resize((size, size), Image.LANCZOS).save(
            os.path.join(UI_IMG, f"icon_{size}.png"), "PNG", optimize=True)

    master.resize((72, 72), Image.LANCZOS).save(
        os.path.join(ASSETS, "PACKAGE_ICON.PNG"), "PNG", optimize=True)
    master.resize((256, 256), Image.LANCZOS).save(
        os.path.join(ASSETS, "PACKAGE_ICON_256.PNG"), "PNG", optimize=True)

    print(f"图标已从项目 logo 生成（源 {SRC}）:")
    for size in SIZES:
        p = os.path.join(UI_IMG, f"icon_{size}.png")
        print(f"  {p}  {os.path.getsize(p)} bytes")
    for name in ("PACKAGE_ICON.PNG", "PACKAGE_ICON_256.PNG"):
        p = os.path.join(ASSETS, name)
        print(f"  {p}  {os.path.getsize(p)} bytes")


if __name__ == "__main__":
    main()
