# 红果短剧 · 群晖 DSM 7 套件（SPK）

把 [hongguo-web-player](https://github.com/NeeYoonc/hongguo-web-player) 打包成群晖套件：
一键安装/升级/卸载，套件中心图标直达网页，内置 ffmpeg（服务端中转）与 ffmpeg.wasm（浏览器直连解密）。

## 产物

| 文件 | 架构 | 说明 |
|---|---|---|
| `hongguoweb_x86_64-<版本>.spk` | x86_64 | DS923+ / 大多数 Intel、AMD 机型 |
| `hongguoweb_armv8-<版本>.spk` | armv8 | ARM64 机型（DS223 等） |

安装：套件中心 → 手动安装 → 选 `.spk`。安装向导可填端口（留空默认 **8788**）。

## 套件内的目录布局

```
/var/packages/hongguoweb/target/       ← 程序（安装包内容）
  bin/hongguoweb                         Go 服务端（静态链接）
  bin/ffmpeg, bin/ffprobe                服务端中转 / 探测用
  web/                                   前端静态资源（含 assets/ffmpeg/ffmpeg-core.wasm）
/var/packages/hongguoweb/var/          ← 数据（升级/卸载保留）
  ports                                  端口记录
  data/                                  账号登录态、收藏、历史
  cache/                                 解密/转码缓存
  hongguoweb.log, hongguoweb.pid
```

数据在 `var/` 下，**升级不丢**；卸载向导默认「保留数据」，选「彻底删除」才清空。

## 本机构建

依赖：Go 1.24+、Python 3（含 tarfile；图标可选 Pillow）、网络可访问 unpkg / johnvansickle。

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

# 3. 打 SPK
ARCH=x86_64 VERSION=1.0.0-1 BIN=.nas-build/bin/hongguoweb-amd64 \
  FFMPEG_DIR=.nas-build/ffmpeg/amd64 WASM=.nas-build/web/ffmpeg-core.wasm \
  bash nas/pack-spk.sh
ARCH=armv8 VERSION=1.0.0-1 BIN=.nas-build/bin/hongguoweb-arm64 \
  FFMPEG_DIR=.nas-build/ffmpeg/arm64 WASM=.nas-build/web/ffmpeg-core.wasm \
  bash nas/pack-spk.sh
```

产物在 `dist/`。图标已随仓库提交（`nas/assets/`），改图标后运行 `python nas/make-icons.py` 重新生成。

## CI

`.github/workflows/nas-spk.yml`：

- `workflow_dispatch`：手动触发，版本号取 `1.0.0-<run_number>`
- push tag `nas-v<版本>`（如 `nas-v1.0.0-1`）：构建双架构并发布 GitHub Release

## 常见问题

| 现象 | 处理 |
|---|---|
| 安装后「打开」打不开 | 确认 8788（或你填的端口）未被其他程序占用；`netstat -tlnp \| grep 8788` |
| 服务端中转模式报错 | 检查 `var/hongguoweb.log`；确认 `target/bin/ffmpeg` 存在且可执行 |
| 直连播放黑屏 | 浏览器控制台看 `assets/ffmpeg/ffmpeg-core.wasm` 是否 404（套件内已内置，若缺失说明打包时没有传 `WASM`） |
| 想换端口 | 卸载重装时在向导里重填，或直接改 `var/ports` 后重启套件 |
