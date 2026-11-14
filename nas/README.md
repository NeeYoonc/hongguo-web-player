# 红果短剧 · 群晖 DSM 7 套件（SPK）

把 [hongguo-web-player](https://github.com/NeeYoonc/hongguo-web-player) 打包成群晖套件。

**不内置 ffmpeg**：直接依赖套件中心「社群」里现成的 SynoCommunity FFmpeg（默认 **FFmpeg 7** / 包名 `ffmpeg7`）。
`INFO` 里写了 `install_dep_packages="ffmpeg7"` —— **没装这个依赖，套件中心会拒绝安装**。

## 产物

| 文件 | 架构 | 说明 |
|---|---|---|
| `hongguoweb_x86_64-<版本>.spk` | x86_64 | DS923+ 等 Intel/AMD 机型 |
| `hongguoweb_armv8-<版本>.spk` | armv8 | ARM64 机型 |

## 安装顺序

1. 套件中心 → **社群** → 安装 **FFmpeg 7**（SynoCommunity，包名 `ffmpeg7`）
2. 套件中心 → 手动安装 → 选 `hongguoweb_<arch>-<版本>.spk`
   - 未装第 1 步时会被拒绝，提示缺少 `ffmpeg7`
3. 安装向导可填端口（默认 **8788**）

## 为什么依赖社区 FFmpeg 也要做 shim

SynoCommunity 的 FFmpeg 包提供的是**带版本后缀**的命令：`ffmpeg7` / `ffprobe7`（不是 `ffmpeg`）。
服务端按 `ffmpeg` / `ffprobe` 调用，所以启动脚本会在数据目录建一层软链：

```
/var/packages/hongguoweb/var/bin/ffmpeg   -> /var/packages/ffmpeg7/target/bin/ffmpeg7
/var/packages/hongguoweb/var/bin/ffprobe  -> /var/packages/ffmpeg7/target/bin/ffprobe7
```

查找顺序：声明的 `ffmpeg7` → `ffmpeg8/ffmpeg6/ffmpeg5/ffmpeg4/ffmpeg` → 系统 PATH 里的 `ffmpeg`。
都找不到时只打印警告：**浏览器直连播放不受影响**，仅服务端中转模式不可用。

## 目录布局

```
/var/packages/hongguoweb/target/         ← 程序
  bin/hongguoweb                           Go 服务端（静态链接）
  web/                                     前端（含 ffmpeg.wasm 解密）
/var/packages/hongguoweb/var/            ← 数据（升级保留）
  bin/ffmpeg, bin/ffprobe                  shim 软链（每次启动重建）
  ports / data / cache / hongguoweb.log / hongguoweb.pid
```

## 本机构建

依赖：Go 1.24+、Python 3（含 tarfile；改图标需 Pillow）。

```sh
# 1. 编译服务端（交叉编译到 linux）
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags '-s -w' -o ../.nas-build/bin/hongguoweb-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags '-s -w' -o ../.nas-build/bin/hongguoweb-arm64 .

# 2. 下载 ffmpeg-core.wasm（浏览器直连解密用；不下载则直连播放不可用）
mkdir -p .nas-build/web
curl -L -o .nas-build/web/ffmpeg-core.wasm https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm

# 3. 打 SPK
ARCH=x86_64 VERSION=1.0.0-3 BIN=.nas-build/bin/hongguoweb-amd64 \
  WASM=.nas-build/web/ffmpeg-core.wasm bash nas/pack-spk.sh
ARCH=armv8 VERSION=1.0.0-3 BIN=.nas-build/bin/hongguoweb-arm64 \
  WASM=.nas-build/web/ffmpeg-core.wasm bash nas/pack-spk.sh
```

想依赖别的 FFmpeg 版本：加 `DEP_PKG=ffmpeg8`（或 `ffmpeg6`/`ffmpeg5`/`ffmpeg`）。

产物在 `dist/`。图标已随仓库提交（`nas/assets/`），改图标后运行 `python nas/make-icons.py`。

## CI

`.github/workflows/nas-spk.yml`：

- `workflow_dispatch`：手动出包（版本 `1.0.0-<run_number>`）
- push tag `nas-v<版本>`（如 `nas-v1.0.0-3`）：双架构构建并发布 GitHub Release
- 依赖包名通过 workflow 的 `env.DEP_PKG` 统一配置

## 常见问题

| 现象 | 处理 |
|---|---|
| 安装被拒、提示缺少 `ffmpeg7` | 先在「社群」里装 FFmpeg 7，再装本套件 |
| 服务端中转模式报错 | 看 `var/hongguoweb.log`；确认 `/var/packages/ffmpeg7/target/bin/ffmpeg7` 存在；必要时改 `DEP_PKG` 重打包 |
| 直连播放黑屏 | 浏览器控制台看 `assets/ffmpeg/ffmpeg-core.wasm` 是否 404（打包时需传 `WASM`） |
| 「打开」打不开 | 确认端口（默认 8788）没被占用：`netstat -tlnp \| grep 8788` |
| 想换端口 | 卸载重装时在向导里重填，或改 `var/ports` 后重启套件 |
