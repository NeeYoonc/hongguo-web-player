#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨平台生成 SPK / package.tgz（显式写入 POSIX 权限位）。

Windows 上 git-bash 的 tar 会把所有文件记成 0644（NTFS 没有 exec 位），
导致安装到 DSM 后二进制/脚本不可执行。这里用 tarfile 显式指定模式：
  bin/*   → 0755
  scripts、WIZARD_UIFILES 里的可执行脚本 → 0755
  其余文件 → 0644，目录 → 0755

用法:
  python3 mktar.py package <src_dir> <out_package.tgz>
  python3 mktar.py spk     <assemble_dir> <out.spk>
"""
import os
import posixpath
import sys
import tarfile

# 外层 spk 必需的条目（顺序与 DSM 规范一致；缺失则跳过）
SPK_ENTRIES = [
    "INFO",
    "PACKAGE_ICON.PNG",
    "PACKAGE_ICON_256.PNG",
    "conf",
    "scripts",
    "ui",
    "WIZARD_UIFILES",
    "package.tgz",
]


def _mode_for(arcname: str, is_dir: bool, kind: str) -> int:
    if is_dir:
        return 0o755
    if kind == "package":
        if arcname.startswith("bin/"):
            return 0o755
        return 0o644
    # spk
    if arcname.startswith("scripts/") and os.path.basename(arcname) != "":
        return 0o755
    return 0o644


def add_tree(tar: tarfile.TarFile, src: str, kind: str, prefix: str = "") -> None:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        files.sort()
        rel_root = os.path.relpath(root, src).replace(os.sep, "/")
        if rel_root == ".":
            rel_root = ""
        # 目录条目
        if rel_root:
            arc = posixpath.join(prefix, rel_root)
            ti = tarfile.TarInfo(arc + "/")
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            tar.addfile(ti)
        for name in files:
            full = os.path.join(root, name)
            rel = posixpath.join(rel_root, name) if rel_root else name
            arc = posixpath.join(prefix, rel)
            st = os.stat(full)
            ti = tarfile.TarInfo(arc)
            ti.size = st.st_size
            ti.mode = _mode_for(arc, False, kind)
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            with open(full, "rb") as f:
                tar.addfile(ti, f)


def make_package(src: str, out: str) -> None:
    with tarfile.open(out, "w:gz", compresslevel=6) as tar:
        add_tree(tar, src, "package")


def make_spk(assemble: str, out: str) -> None:
    with tarfile.open(out, "w") as tar:
        for entry in SPK_ENTRIES:
            full = os.path.join(assemble, entry)
            if not os.path.exists(full):
                continue
            if os.path.isdir(full):
                ti = tarfile.TarInfo(entry + "/")
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                ti.mtime = 0
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = "root"
                tar.addfile(ti)
                add_tree(tar, full, "spk", prefix=entry + "/")
            else:
                st = os.stat(full)
                ti = tarfile.TarInfo(entry)
                ti.size = st.st_size
                ti.mode = _mode_for(entry, False, "spk")
                ti.mtime = 0
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = "root"
                with open(full, "rb") as f:
                    tar.addfile(ti, f)


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] not in ("package", "spk"):
        print(__doc__)
        sys.exit(2)
    kind, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    if kind == "package":
        make_package(src, out)
    else:
        make_spk(src, out)
    print(f"  ✓ {kind}: {out} ({os.path.getsize(out) / 1048576:.1f} MiB)")


if __name__ == "__main__":
    main()
