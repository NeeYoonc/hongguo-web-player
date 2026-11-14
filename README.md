# 红果短剧 Web 客户端

一个跑在群晖 NAS 上的红果短剧网页版：搜索、分类、详情、选集、清晰度切换、上下集、自动连播、进度记忆。
取流复用「红果鉴」(guoapp) 的 Go 核心（设备注册 / 签名 / 播放地址 / CENC 解密），不需要手机 App。

## 访问地址

- 局域网：**http://192.168.2.22:8788**
- 建议用桌面 Chrome / Edge / Safari 打开；手机浏览器同样可用（竖屏体验一般）。

## 启动 / 停止

```sh
/volume1/AI/红果/client/start.sh   # 启动（已在运行会直接提示）
/volume1/AI/红果/client/stop.sh    # 停止
tail -f /volume1/AI/红果/client/server.log   # 看日志
```

开机自启：群晖「控制面板 → 任务计划 → 新增 → 触发的任务 → 开机」，用户选 root，
命令填 `/volume1/AI/红果/client/start.sh`。

## 播放原理（为什么需要本机 ffmpeg）

红果 App 的播放地址是 **HEVC 编码 + CENC 加密** 的 MP4，浏览器不能直接播放，所以服务端做了一层适配：

| 浏览器 | 路径 | 说明 |
| --- | --- | --- |
| Safari / iOS / 支持 HEVC 的 Edge/Chrome | `/dec` | ffmpeg 用解密密钥把流 remux 成普通 HEVC MP4 并缓存，原生播放、拖动秒响应、保留全部清晰度（最高 1080P） |
| Chrome / Firefox 等不支持 HEVC | `/tc` | ffmpeg 实时转码成 H.264 fMP4，前端用 MSE 播放，支持拖动（拖到未转码区域会重新起转，约 1~2 秒） |

- 首次播放有 1~3 秒「正在取流」准备时间（要等 ffmpeg 起转/解密缓存）。
- 转码路径输出 720P（NAS 的 CPU 软解 1080P HEVC 约 2.3 倍速，够实时播放）。
- 解密后的视频缓存在 `cache/dec/`，上限 4GB，超出自动删最旧的；重看同一集秒开。

## 目录

```
client/
├── server/           Go 服务（main.go + player.go），二进制 hongguoweb
├── web/              前端（index.html / app.js / style.css）
├── data/             红果鉴核心的数据目录（设备信息、目录缓存）
├── cache/            /dec 解密缓存
├── start.sh / stop.sh
└── server.log
```

## 注意

- 服务监听 `0.0.0.0:8788`，**没有登录鉴权**，只适合局域网使用，不要做端口映射暴露到公网。
- 同时观看多路时每路转码会占 1~2 个 CPU 核；NAS 是 2 核 4 线程，建议同时不超过 2 路。
- 依赖 NAS 自带的 ffmpeg（7.0.2，含 libx264 / HEVC 解码器）。若系统里没有，`-ffmpeg` 参数可指定路径。
- 上游接口/签名由 guoapp 核心维护；红果改版后需要同步更新 `/volume1/AI/guoapp/native/core` 并重新编译。

## 本机账号（收藏 / 点赞 / 历史）

- 侧栏底部「登录」可注册/登录**本机账号**（用户名 2-20 字符、密码至少 4 位），数据保存在 `data/users.json`，按账号隔离收藏、点赞与观看历史。
- 登录后：播放页右侧 ☆ 收藏、♡ 点赞；侧栏「收藏·点赞」「历史」查看对应列表；退出登录后回到游客态（游客的收藏/点赞暂存在浏览器本地）。
- 说明：这是**本机账号**，不是红果官方账号。红果官方登录需要手机号短信验证并走官方 passport 接口，当前核心未接入；本机账号仅用于本站内的数据归属，不涉及红果账号权益。

## 群晖 DSM 7 套件（SPK）

已提供套件打包（见 `nas/`），拆成两个包：

| 顺序 | 套件 | 说明 |
|---|---|---|
| 1 | `ffmpeg-static` | 静态 ffmpeg/ffprobe（前置依赖，无后台服务） |
| 2 | `hongguoweb` | Web 客户端；`INFO` 内含 `install_dep_packages="ffmpeg-static"`，**未装依赖会被套件中心拒绝安装** |

- 下载：<https://github.com/NeeYoonc/hongguo-web-player/releases>（`nas-v*` 标签，x86_64 / armv8）
- 安装：套件中心 → 手动安装 → 先 `ffmpeg-static_*.spk`，再 `hongguoweb_*.spk`（端口默认 8788，向导可改）
- 构建/细节：见 [`nas/README.md`](nas/README.md)

## 更新记录

- v126：观看进度写回红果账号（`/reading/bookapi/read_history/update/v` + `/reading/bookapi/read_progress/upload/v`，注意 update 用数字 id、upload 用字符串 id）；历史页本地进度与账号进度按时间合并。
- v119–v122：浏览器端 ffmpeg.wasm 本地解密直连播放（CENC/H.265），解密缓存与下一集预解密。
- v112：登录会话改存浏览器 localStorage（`hg:cookies`），服务端不再落盘。
