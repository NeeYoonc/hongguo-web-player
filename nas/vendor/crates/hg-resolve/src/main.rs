//! 红果取流 CLI（匿名、免登录）：复用 hongguo-api 的官方 App v5 取流实现。
//!
//! 用法：`hg-resolve <series_id> <vid> [definition] [--device <json>]`
//! 首次运行会注册一台新设备并把设备档案保存到 device JSON，后续复用（避免反复注册）。
//! 输出：一行 JSON（ok/url/encrypted/codec/definition/key_hex）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use hongguo_api::client::ApiEnv;
use hongguo_api::detail::fetch_episode_list;
use hongguo_api::play_url::{fetch_play_url, register_content_type};
use hongguo_api::stream_pick::DecoderCapability;
use hongguo_signer::device::{anonymous_cookie, DeviceProfile};

async fn build_env(device_path: &PathBuf) -> Result<ApiEnv, String> {
    if device_path.exists() {
        let raw = std::fs::read_to_string(device_path).map_err(|e| e.to_string())?;
        let device: DeviceProfile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        eprintln!("[device] 复用已注册设备档案 {}", device_path.display());
        return Ok(ApiEnv {
            proxy: Default::default(),
            cookie: Some(anonymous_cookie(&device)),
            x_tt_token: None,
            device,
        });
    }

    eprintln!("[device] 首次运行：注册新设备…");
    let reg_env = ApiEnv::anonymous(Default::default());
    let reg = hongguo_api::register::register_device(&reg_env)
        .await
        .map_err(|e| format!("设备注册失败: {e}"))?;
    let mut device = DeviceProfile::fresh_register_profile(&reg.cdid, &reg.openudid);
    device.set("device_id", &reg.device_id);
    device.set("iid", &reg.install_id);
    device.set_ttreq(Some(reg.ttreq.clone()));
    let env = ApiEnv {
        proxy: Default::default(),
        cookie: Some(anonymous_cookie(&device)),
        x_tt_token: None,
        device,
    };
    if let Ok(json) = serde_json::to_string(&env.device) {
        if let Err(e) = std::fs::write(device_path, json) {
            eprintln!("[device] 档案保存失败（不影响本次）: {e}");
        } else {
            eprintln!("[device] 已保存设备档案 {}", device_path.display());
        }
    }
    Ok(env)
}

/// MetaSec SDI 会话的落盘存储（缺失时按内存处理，不影响取流）。
struct FileSessions {
    path: PathBuf,
}

fn read_sessions(path: &Path) -> HashMap<String, (String, i64)> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<HashMap<String, (String, i64)>>(&raw).ok())
        .unwrap_or_default()
}

impl hongguo_api::metasec::SessionStore for FileSessions {
    fn load(&self, profile_key: &str) -> hongguo_common::AppResult<Option<hongguo_api::metasec::sdi::SdiToken>> {
        let map = read_sessions(&self.path);
        Ok(map.get(profile_key).map(|(value, status)| hongguo_api::metasec::sdi::SdiToken {
            value: value.clone(),
            status: *status,
        }))
    }

    fn save(&self, profile_key: &str, token: &hongguo_api::metasec::sdi::SdiToken) -> hongguo_common::AppResult<()> {
        let mut map = read_sessions(&self.path);
        map.insert(profile_key.to_string(), (token.value.clone(), token.status));
        if let Ok(raw) = serde_json::to_string(&map) {
            let _ = std::fs::write(&self.path, raw);
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut device_path = std::env::var("HONGGUO_DEVICE_JSON")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("hg-device.json"));
    if let Some(pos) = args.iter().position(|a| a == "--device") {
        if pos + 1 < args.len() {
            device_path = PathBuf::from(args[pos + 1].clone());
            args.drain(pos..=pos + 1);
        }
    }
    let comments_mode = args.iter().any(|a| a == "--comments");
    args.retain(|a| a != "--comments");

    let mut forced_ct: i64 = 0;
    if let Some(pos) = args.iter().position(|a| a == "--ct") {
        if pos + 1 < args.len() {
            forced_ct = args[pos + 1].parse().unwrap_or(0);
            args.drain(pos..=pos + 1);
        }
    }
    if args.len() < 2 {
        eprintln!("用法: hg-resolve <series_id> <vid> [definition] [--ct <content_type>] [--device <json>]");
        std::process::exit(64);
    }
    let series_id = args[0].clone();
    let vid = args[1].clone();
    let definition: Option<u32> = args.get(2).and_then(|s| s.parse().ok());

    // MetaSec v5 物料缓存与会话落盘：不配置的话每个进程都会重新下载官方 APK 片段
    let work_dir = device_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&work_dir);
    hongguo_api::metasec::configure_app(
        &work_dir.join("hg-metasec.db"),
        Arc::new(FileSessions {
            path: work_dir.join("hg-metasec-sessions.json"),
        }),
    );

    let env = match build_env(&device_path).await {
        Ok(env) => env,
        Err(e) => {
            println!("{}", serde_json::json!({"ok": false, "error": e}));
            std::process::exit(3);
        }
    };

    if comments_mode {
        match hongguo_api::danmaku::fetch_comments_page(&vid, &series_id, "", &env).await {
            Ok(page) => {
                let items: Vec<serde_json::Value> = page
                    .items
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "user": c.user_name,
                            "avatar": c.avatar,
                            "text": c.text,
                            "time": c.create_time,
                            "digg": c.digg_count,
                        })
                    })
                    .collect();
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "data": { "total": page.total, "items": items }
                    })
                );
            }
            Err(e) => {
                println!("{}", serde_json::json!({"ok": false, "error": e.to_string()}));
                std::process::exit(2);
            }
        }
        return;
    }

    let mut content_type = forced_ct;
    if forced_ct > 0 {
        eprintln!("[detail] 跳过（使用缓存 content_type={forced_ct}）");
    } else {
        match fetch_episode_list(&series_id, &env).await {
            Ok(list) => {
                content_type = list.content_type;
                eprintln!(
                    "[detail] 剧名={} 分集={} content_type={}",
                    list.title,
                    list.episodes.len(),
                    content_type
                );
            }
            Err(e) => eprintln!("[detail] 失败: {e}"),
        }
    }
    if content_type > 0 {
        register_content_type(&vid, content_type);
    }

    // 官方 APK 片段（MetaSec v5 物料）偶发 404：重试两次再放弃
    let mut attempt = 0;
    let play_result = loop {
        match fetch_play_url(&vid, definition, DecoderCapability::full(), &env).await {
            Ok(info) => break Ok(info),
            Err(e) => {
                let text = e.to_string();
                if attempt < 2 && text.contains("APK Range unavailable") {
                    attempt += 1;
                    eprintln!("[play] 物料下载偶发失败，重试 {attempt}/2: {text}");
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    continue;
                }
                break Err(e);
            }
        }
    };
    match play_result {
        Ok(info) => {
            let cenc_key = hongguo_video::crypto::key_derive::derive_key(&info.key_material)
                .ok()
                .map(hex::encode);
            let out = serde_json::json!({
                "ok": true,
                "url": info.url,
                "cenc_key_hex": cenc_key,
                "encrypted": info.encrypted,
                "codec": info.codec,
                "definition": info.definition,
                "key_hex": hex::encode(&info.key_material),
                "file_hash": info.file_hash,
                "content_type": content_type,
                "qualities": info
                    .definitions
                    .iter()
                    .map(|d| d.value)
                    .collect::<Vec<_>>(),
            });
            println!("{out}");
        }
        Err(e) => {
            println!("{}", serde_json::json!({"ok": false, "error": e.to_string()}));
            std::process::exit(2);
        }
    }
}
