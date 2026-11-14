# 红果短剧 Web 客户端

把红果短剧（hongguoduanju.com / 红果 App 接口）搬到浏览器里的自托管播放器：推荐流、找剧、排行榜、新剧/上新日历、历史、收藏、点赞、追更/预约、搜索、详情页、演员主页、弹幕、评论抽屉、清晰度切换、浏览器本地解密直连播放。

> 仅供个人学习研究，内容版权归红果短剧及其权利人所有。请使用你自己的账号登录。

## 功能

- **推荐流**：关注 / 漫剧 / 真人剧 / 推荐四个 tab，滚轮或 ↑↓ 切换；播放超过 1 集后滚轮切集，返回推荐页后滚轮切剧。
- **找剧**：体裁 + 热门/情节/主题/背景/角色/推荐/状态多行筛选，卡片带热度、集数、评分，点击直接播放。
- **详情页**：主创/演员、备案号、标签、选集（序号+时长）、相关推荐；点演员进创作者主页（简介/粉丝/获赞/红果号/作品列表）。
- **新剧**：新剧推荐（按上线时间、男频/女频）+ 上新日历（15 天日期条、预约数）。
- **播放器**：自绘控制条、选集区间、倍速、清晰度、弹幕（含 53 个表情）、评论抽屉、右侧点赞/评论/收藏；PC 与手机自适应。
- **直连播放**：浏览器 fetch 红果 CDN + ffmpeg.wasm 本地解密（HEVC/AAC → fMP4），不经过服务器中转；也可切回服务器中转（ffmpeg + `-decryption_key`）。
- **账号**：扫码登录（红果短剧二维码，aid=513755），会话保存在浏览器 localStorage；服务端不落盘会话。

## 目录结构

```
web/            前端（index.html / app.js / style.css / assets）
web/assets/ffmpeg/  ffmpeg.wasm 运行时（wasm 需自行下载，见下）
server/         Go HTTP 服务：静态资源、/api、/dec（解密中转）、/comments（网页评论解析）
native/         红果接口 core（签名、设备、取流、收藏/历史/点赞/预约、弹幕、创作者等）
start.sh stop.sh supervise.sh   启动/停止/守护脚本
```

## 构建与运行

依赖：Go 1.24+、ffmpeg（中转模式需要）、Node 18+（可选，服务端弹幕签名脚本）。

```sh
# 1. ffmpeg.wasm（直连播放需要，仓库未附带 31MB 的 wasm）
#    从 @ffmpeg/core 0.12.6 取 ffmpeg-core.wasm 放到 web/assets/ffmpeg/
#    https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm

# 2. 编译服务端
cd server && go build -o hongguoweb .

# 3. 启动（默认 8788 端口）
./start.sh
```

打开 `http://<主机IP>:8788`，首次使用在设置里扫码登录。

## 说明

- 红果接口需要设备签名；`native/` 内已包含签名实现，无需额外配置。
- 直连播放依赖红果 CDN 的 CORS（`Access-Control-Allow-Origin: *`），如失效会自动回落到服务器中转。
- 弹幕读取走服务端 `signer/fetch_danmaku.mjs`（可选组件，缺失时弹幕为空）。
