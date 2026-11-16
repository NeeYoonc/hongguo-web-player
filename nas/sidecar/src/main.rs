//! 红果取流 CLI（匿名、免登录）：复用 hongguo-api 的官方 App v5 取流实现。
//!
//! 用法：`hg-resolve <series_id> <vid> [definition] [--device <json>]`
//! 首次运行会注册一台新设备并把设备档案保存到 device JSON，后续复用（避免反复注册）。
//! 输出：一行 JSON（ok/url/encrypted/codec/definition/key_hex）。

use std::path::PathBuf;

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
    if args.len() < 2 {
        eprintln!("用法: hg-resolve <series_id> <vid> [definition] [--device <json>]");
        std::process::exit(64);
    }
    let series_id = args[0].clone();
    let vid = args[1].clone();
    let definition: Option<u32> = args.get(2).and_then(|s| s.parse().ok());

    let env = match build_env(&device_path).await {
        Ok(env) => env,
        Err(e) => {
            println!("{}", serde_json::json!({"ok": false, "error": e}));
            std::process::exit(3);
        }
    };

    let mut content_type = 0i64;
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
    if content_type > 0 {
        register_content_type(&vid, content_type);
    }

    match fetch_play_url(&vid, definition, DecoderCapability::full(), &env).await {
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
