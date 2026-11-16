# 第三方代码说明（vendor）

本目录 `crates/` 下的以下 crate 来自开源项目 **hongguo-desktop**（红果桌面版）：

- 上游仓库：https://github.com/it00021hot/hongguo-desktop
- 固定提交：`374b1819b0c4ae2f77cf6008e1c138f92f1f16bd`（2026-11-13，`chore: 合并 dev 到 main`）
- 许可证：**PolyForm Noncommercial 1.0.0**（见同目录 `LICENSE`）

| crate | 用途 |
|---|---|
| `hongguo-signer` | 字节系请求签名（x-gorgon / x-argus / x-ladon / x-helios / x-medusa）与设备注册原语 |
| `hongguo-api` | 官方 App 接口客户端（设备注册 / 详情 / 取流 v5 等） |
| `hongguo-common` | 共用底座（领域模型、错误类型、工具） |
| `hongguo-video` | MP4 解析与 CENC 解密（密钥派生） |
| `hongguo-bytevc2` | ByteVC2 识别与解帧（本项目只做选流，默认关闭 vvdec，走纯 Rust oxideav） |

`crates/hg-resolve` 是本项目新增的取流 CLI（不是上游代码），用于把上述能力暴露成一个
可被 Go 服务端调用的命令行工具。

## 修改记录

- `hongguo-bytevc2` 的默认特性由 `["vvdec", "oxideav"]` 改为 `["oxideav"]`，避免构建期
  依赖 `pkg-config`/`libvvdec`（本项目不解码，不选 ByteVC2）。
- 各 crate 的 `version/edition/rust-version/license/authors` 由本目录 workspace 统一提供
  （`rust-version` 调整为实际可用的 stable 下限）。

## 使用限制

上游为 **非商业许可**：仅供学习研究、个人自用；不得用于商业分发。本仓库只做自托管
套件打包，不存储、不分发任何影视内容。
