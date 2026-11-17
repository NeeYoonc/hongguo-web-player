# 红果短剧 Web 客户端（群晖 NAS 套件）

把红果短剧搬到浏览器里的自托管播放器：推荐流、找剧、排行榜、新剧/上新日历、历史、收藏、点赞、追更/预约、搜索、详情页、演员主页、**弹幕**、评论抽屉、清晰度切换、浏览器本地解密直连播放。

以 **群晖 DSM 7 套件（SPK）** 形式发布：套件中心一键安装 / 升级 / 卸载，套件图标直达网页。

> 仅供个人学习研究，内容版权归红果短剧及其权利人所有。请使用你自己的账号登录。

## 安装（群晖 DSM 7）

**前置依赖**（缺任一个都会拒绝安装）：

| 依赖 | 包名 | 来源 |
|---|---|---|
| FFmpeg 7 | `ffmpeg7` | 套件源 `https://ssp.dnof.net/` 或 社群（SynoCommunity） |
| Node.js v22 | `Node.js_v22` | 套件中心官方套件（开发工具） |

### 方式一：套件源（推荐，自动跟进版本）

1. 套件中心 → **设置 → 套件来源 → 新增**
   - 名称：任意（如 `dnof`）
   - 位置：`https://ssp.dnof.net/`
2. 确定后回到套件中心 → **社群** → 搜索「红果短剧」→ 安装
   （该来源同时提供 `ffmpeg7`，可一并装上）
3. 待「红果短剧」出现新版本时，套件中心会提示更新

### 方式二：手动安装（Release 下载 .spk）

套件中心 → 手动安装 → 选 `hongguoweb_<arch>.spk`
（`x86_64` = DS923+/Intel/AMD；`armv8` = ARM64 机型）。

- 安装向导可填 **Web 端口**（默认 8788，留空即可）
- 安装完成后套件中心出现「打开」按钮，点开即用
- 下载地址：<https://github.com/NeeYoonc/hongguo-web-player/releases>（`nas-v*` 标签）

依赖写在 `INFO` 的 `install_dep_packages="ffmpeg7:Node.js_v22"` 里，**没有依赖装不上**。

## 功能

- **推荐流**：关注 / 漫剧 / 真人剧 / 推荐四个 tab，滚轮或 ↑↓ 切换；播放超过 1 集后滚轮切集，返回推荐页后滚轮切剧。
- **找剧**：体裁 + 热门/情节/主题/背景/角色/推荐/状态多行筛选，卡片带热度、集数、评分，点击直接播放。
- **详情页**：主创/演员、备案号、标签、选集（序号+时长）、相关推荐；点演员进创作者主页。
- **新剧**：新剧推荐（按上线时间、男频/女频）+ 上新日历（15 天日期条、预约数）。
- **播放器**：自绘控制条、选集区间、倍速、清晰度、**弹幕（含 53 个表情）**、评论抽屉、右侧点赞/评论/收藏；PC 与手机自适应。
- **画中画（超分可用）**：播放器控制条新增画中画按钮，用 Document Picture-in-Picture（Chrome 116+）把超分画布搬进 PiP 窗口，画中画里也是超分画面；浏览器原生 PiP（右键/媒体中心）只能显示 `<video>`，会自动暂停超分并隐藏页内画面避免两个画面。
- **GPU 超分辨率**：WebGL2 两趟 shader（Catmull-Rom 重建放大 + CAS 对比度自适应锐化）实时渲染到屏幕原生分辨率（HiDPI 最多 2x），全程 GPU、不占 CPU；播放器设置里开关与锐度可调。
- **直连播放**：浏览器 fetch 红果 CDN + 套件内置的 ffmpeg.wasm 本地解密（HEVC/AAC → fMP4），不经过服务器中转；也可切回服务器中转（用依赖套件的 ffmpeg）。
- **官方 App 取流通道（v1.0.0-14 起）**：红果 2026-11-16 收紧旧签名后，取流改由随包分发的 `hg-resolve` 侧车完成——匿名注册设备 → 拉分集详情注册条目类型 → 按官方 App v5 协议（MetaSec v5 + `sinfonlinea` 域）取流 → 派生 CENC 密钥。**不需要登录**，首次播放会注册一台设备（档案存在 `var/hg-device.json`，升级保留）。网页端 `_ROUTER_DATA` 回落已移除（那里现在只有加密流）。
- **本机账号**：侧栏底部可注册/登录本站账号（收藏、点赞、历史按账号隔离）。

## 播放原理（为什么要 ffmpeg）

红果播放地址是 **HEVC + CENC 加密**的 MP4，浏览器不能直接播，套件提供两条路径：

| 浏览器 | 路径 | 说明 |
|---|---|---|
| Safari / iOS / 支持 HEVC 的 Chrome/Edge | `/dec` | 依赖套件的 ffmpeg 用解密密钥 remux 成普通 HEVC MP4 并缓存，原生播放、拖动秒响应、最高 1080P |
| Chrome / Firefox 等不支持 HEVC | `/tc` | ffmpeg 实时转码 H.264 fMP4，前端 MSE 播放（拖到未转码区域会重新起转，约 1~2 秒） |
| 直连模式 | 浏览器端 | 套件内置 `ffmpeg-core.wasm` 在浏览器本地解密，不占服务器 CPU |

解密缓存位于套件数据目录，上限 4GB，超出自动淘汰最旧的。

## 套件目录与数据

```
/var/packages/hongguoweb/target/     程序（升级时整体替换）
  bin/hongguoweb                       Go 服务端
  web/                                 前端（含 assets/ffmpeg/ffmpeg-core.wasm）
  signer/                              弹幕签名组件（fetch_danmaku.mjs + danmu_api + node_modules）
  bin/hg-resolve                       取流侧车（官方 App v5 通道；Rust，静态 musl）
/var/packages/hongguoweb/var/        数据（升级保留）
  ports                                端口
  data/                                设备信息、目录缓存、本机账号（users.json）
  cache/                               解密/转码缓存
  bin/                                 ffmpeg / ffprobe / node 的 shim 软链（每次启动重建）
  hongguoweb.log / hongguoweb.pid
```

- **升级**：套件中心直接装新版本，数据保留
- **卸载**：卸载向导默认「保留数据」，选「彻底删除」才清空
- **回退**：卸载（保留数据）→ 装回旧版本

## 注意

- 服务监听 `0.0.0.0:<端口>`，**没有鉴权**，只适合局域网使用，不要做端口映射暴露公网。
- 多路同时观看时每路转码占 1~2 个 CPU 核，建议同时不超过 2 路。
- 弹幕需要**红果账号登录态**（浏览器 localStorage 里的 cookies，按请求发给服务端）；未登录时弹幕为空、评论不可用，不影响播放。
- 红果改版后签名/接口可能失效，需要同步上游 `native/core` 重新编译。

## 开发 / 非群晖部署

本仓库同时保留手动运行方式（适合调试）：

```sh
# 依赖：Go 1.24+、ffmpeg、Node 18+（弹幕用）
cd server && go build -o hongguoweb .        # 交叉编译加 GOOS=linux
./hongguoweb -addr 0.0.0.0:8788 -data ./data -web ./web -cache ./cache
```

弹幕组件在 `nas/assets/danmu/`（源码入库，`node_modules` 构建期 `npm install --omit=dev` 生成）：

```sh
cd nas/assets/danmu && npm install --omit=dev --no-audit --no-fund
```

打群晖套件见 [`nas/README.md`](nas/README.md)。

## 更新记录

- v126：观看进度写回红果账号（`/reading/bookapi/read_history/update/v` + `/reading/bookapi/read_progress/upload/v`）；历史页本地进度与账号进度按时间合并。
- v119–v122：浏览器端 ffmpeg.wasm 本地解密直连播放（CENC/H.265），解密缓存与下一集预解密。
- v1.0.0-21：GPU 超分辨率（WebGL2 重建 + CAS 锐化，替换原先占 CPU 的 SVG 卷积滤镜）。
- v1.0.0-14 ~ -17：适配红果 11-16 取流收紧 —— 侧车 `hg-resolve` 复用官方 App v5 通道（MetaSec v5 + sinfonlinea + gzip body + token 前 56 位），服务端 `/appplay/<sid>/<vid>` 反向代理 CDN 流，剩余解密链路不变；移除失效的网页回落。
- v112：登录会话改存浏览器 localStorage（`hg:cookies`），服务端不再落盘。
