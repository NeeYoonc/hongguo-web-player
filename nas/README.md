# 红果短剧 · 群晖 DSM 7 套件（SPK）

把 [hongguo-web-player](https://github.com/NeeYoonc/hongguo-web-player) 打包成群晖套件。
拆成**两个包**：`ffmpeg-static`（前置依赖，静态 ffmpeg/ffprobe）+ `hongguoweb`（Web 客户端，**必须**先装依赖）。

## 产物与安装顺序

| 顺序 | 文件 | 架构 | 大小 | 说明 |
|---|---|---|---|---|
| 1 | `ffmpeg-static_x86_64-<版本>.spk` / `_armv8-` | x86_64 / armv8 | ~57 / 49 MB | 静态 `ffmpeg` + `ffprobe`，无服务 |
| 2 | `hongguoweb_x86_64-<版本>.spk` / `_armv8-` | x86_64 / armv8 | ~16 MB | Web 客户端（不内置 ffmpeg） |

- `hongguoweb` 的 `INFO` 写了 `install_dep_packages="ffmpeg-static"`：
  **没装 `ffmpeg-static` 时，套件中心会拒绝安装**并提示先装依赖。
- 安装：套件中心 → 手动安装 → 先 `ffmpeg-static`，再 `hongguoweb`。
- `hongguoweb` 安装向导可填端口（默认 **8788**）。

## 目录布局

```
/var/packages/ffmpeg-static/target/bin/ffmpeg, ffprobe   ← 依赖包提供
/var/packages/hongguoweb/target/                         ← 客户端程序
  bin/hongguoweb                                            Go 服务端（静态链接）
  web/                                                      前端（含 ffmpeg.wasm 解密）
/var/packages/hongguoweb/var/                            ← 数据（升级保留）
  ports / data / cache / hongguoweb.log / hongguoweb.pid
```

`hongguoweb` 启动时把 `/var/packages/ffmpeg-static/target/bin` 加进 `PATH`，
服务端中转模式即用依赖包的 ffmpeg；依赖缺失时只降级（中转不可用，浏览器直连播放仍可）。

## 本机构建

依赖：Go 1.24+、Python 3（含 tarfile；生成图标需 Pillow）、网络可访问 unpkg / johnvansickle。

```sh
# 1. 编译服务端（交叉编译到 linux）
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w' -o ../.nas-build/bin/hongguoweb-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags '-s -w' -o ../.nas-build/bin/hongguoweb-arm64 .

# 2. 下载运行时依赖
mkdir -p .nas-build/web .nas-build/ffmpeg/amd64 .nas-build/ffmpeg/arm64
curl -L -o .nas-build/web/ffmpeg-core.wasm https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
curl -L -o /tmp/ffmpeg-amd64.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xJf /tmp/ffmpeg-amd64.tar.xz -C .nas-build/ffmpeg/amd64 --strip-components=1
curl -L -o /tmp/ffmpeg-arm64.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz
tar -xJf /tmp/ffmpeg-arm64.tar.xz -C .nas-build/ffmpeg/arm64 --strip-components=1

# 3. 打四个包
#    依赖包（先）
PKG=ffmpeg-static ARCH=x86_64 VERSION=1.0.0-2 FFMPEG_DIR=.nas-build/ffmpeg/amd64 bash nas/pack-spk.sh
PKG=ffmpeg-static ARCH=armv8 VERSION=1.0.0-2 FFMPEG_DIR=.nas-build/ffmpeg/arm64 bash nas/pack-spk.sh
#    客户端
PKG=hongguoweb ARCH=x86_64 VERSION=1.0.0-2 BIN=.nas-build/bin/hongguoweb-amd64 \
  WASM=.nas-build/web/ffmpeg-core.wasm bash nas/pack-spk.sh
PKG=hongguoweb ARCH=armv8 VERSION=1.0.0-2 BIN=.nas-build/bin/hongguoweb-arm64 \
  WASM=.nas-build/web/ffmpeg-core.wasm bash nas/pack-spk.sh
```

产物在 `dist/`。图标已随仓库提交（`nas/assets/`），改图标后运行 `python nas/make-icons.py` 重新生成。

## CI

`.github/workflows/nas-spk.yml`：

- `workflow_dispatch`：手动触发，版本号取 `1.0.0-<run_number>`
- push tag `nas-v<版本>`（如 `nas-v1.0.0-2`）：双架构 × 双包构建，发布 GitHub Release

## 常见问题

| 现象 | 处理 |
|---|---|
| 安装 `hongguoweb` 被拒 | 提示缺少 `ffmpeg-static` → 先装依赖包，再装客户端 |
| 服务端中转模式报错 | 确认 `/var/packages/ffmpeg-static/target/bin/ffmpeg` 可执行；看 `var/hongguoweb.log` |
| 直连播放黑屏 | 浏览器控制台看 `assets/ffmpeg/ffmpeg-core.wasm` 是否 404（打包时需传 `WASM`） |
| 「打开」打不开 | 确认端口（默认 8788）没被占用：`netstat -tlnp \| grep 8788` |
| 想换端口 | 卸载重装时在向导里重填，或改 `var/ports` 后重启套件 |
