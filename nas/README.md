# 红果短剧 · 群晖 DSM 7 套件（SPK）打包

把 [hongguo-web-player](../README.md) 打成 DSM 7 套件。产物只有一个包 `hongguoweb_<arch>-<版本>.spk`。

## 依赖策略

| 依赖 | 包名 | 用途 | 说明 |
|---|---|---|---|
| FFmpeg 7 | `ffmpeg7` | 服务端 remux/转码（`/dec`、`/tc`） | 套件中心「社群」安装 |
| Node.js v22 | `Node.js_v22` | 执行弹幕签名脚本 | 套件中心官方「开发工具」 |

`INFO` 写入 `install_dep_packages="ffmpeg7:Node.js_v22"` —— **缺任一依赖，套件中心拒绝安装**。

套件源：`https://ssp.dnof.net/`（套件中心 → 设置 → 套件来源 → 新增，自动同步本仓 Release）。

## 包内容

```
bin/hongguoweb                 Go 服务端（linux 静态二进制）
web/                           前端（含 assets/ffmpeg/ffmpeg-core.wasm）
signer/                        弹幕组件：fetch_danmaku.mjs + danmu_api/ + node_modules/
ui/ + conf/ + scripts/         门户配置、运行用户、启停与安装钩子
```

- **不内置** ffmpeg/ffprobe：启动时在 `var/bin` 建 shim 指向 `/var/packages/ffmpeg7/target/bin/{ffmpeg,ffprobe}`
- **不内置** node：启动时在 `var/bin` 建 shim 指向 `/var/packages/Node.js_v22/target/usr/local/bin/node`
- `signer/node_modules` 不入库，打包时用 `npm install --omit=dev` 现装（约 100MB，压缩后 SPK ≈ 36MB）

## 构建

依赖：Go 1.24+、Python 3（含 tarfile）、Node.js + npm（装弹幕依赖）、Pillow（改图标时）。

```sh
# 1. 编译服务端（linux，两种架构）
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags '-s -w' -o ../.nas-build/bin/hongguoweb-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags '-s -w' -o ../.nas-build/bin/hongguoweb-arm64 .

# 2. ffmpeg-core.wasm（浏览器直连解密；缺失则直连不可用）
mkdir -p .nas-build/web
curl -L -o .nas-build/web/ffmpeg-core.wasm https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm

# 3. 打包（内置 signer；首次会自动 npm install）
ARCH=x86_64 VERSION=1.0.0-8 BIN=.nas-build/bin/hongguoweb-amd64 \
  WASM=.nas-build/web/ffmpeg-core.wasm bash nas/pack-spk.sh
ARCH=armv8 VERSION=1.0.0-8 BIN=.nas-build/bin/hongguoweb-arm64 \
  WASM=.nas-build/web/ffmpeg-core.wasm bash nas/pack-spk.sh
```

可覆盖的环境变量：`DEP_PKG`（默认 `ffmpeg7`）、`DEP_NODE`（默认 `Node.js_v22`）、`OUT_DIR`、`BUILD_ROOT`、`NPM_REGISTRY`。

## CI

`.github/workflows/nas-spk.yml`：`workflow_dispatch` 手动出包（版本 `1.0.0-<run_number>`）；push tag `nas-v<版本>` 时双架构构建并发布 GitHub Release。

## 图标

取自官方 1024×1024 图标 `nas/assets/source/hongguo-short-drama-1024.png`（`web/assets/logo.png` 40×40 仅兜底），
运行 `python nas/make-icons.py` 重新生成 `PACKAGE_ICON` 与 `ui/images`。

## 常见问题

| 现象 | 处理 |
|---|---|
| 安装被拒，提示缺依赖 | 先装 FFmpeg 7（社群）+ Node.js v22（官方） |
| 安装后没有「打开」按钮 | `ui/` 必须同时放进 `package.tgz`（`target/ui`），DSM 才会生成 `webman/3rdparty` 链接 |
| 弹幕不显示 | ① 未登录红果账号（无 cookies，弹幕为空）② `var/bin/node` shim 缺失 ③ 查看 `var/hongguoweb.log` 的 `danmaku` 行 |
| 图标还是旧的 | DSM 缓存套件图标：停/启动一次或重开套件中心 |
