package main

// App 接口取流回落（2026-11-16 起红果收紧后的正式通道）
//
// 背景：红果 App 取流接口对旧签名（Gorgon/Argus/Ladon）返回 200 空体，网页端
// `_ROUTER_DATA` 也不再带播放地址。官方 App 仍能播，说明新通道是 MetaSec v5 签名
// + sinfonlinea 域（APK 内 `api5-normal-sinfonlinea` 出现 13 次、sinfonlineb 仅 1 次）。
//
// 本文件不重新实现 v5 签名，而是旁路复用已验证可用的 Rust 实现：
//   - 侧车 `hg-resolve`（由 hongguo-desktop 的 hongguo-signer/hongguo-api 编成的小 CLI）
//     负责：注册匿名设备 → 拉分集详情注册 content_type → v5 取流 → 派生 CENC 密钥；
//   - 输出一行 JSON：{ok,url,encrypted,codec,definition,key_hex,cenc_key_hex}
//   - 服务端把 CDN 地址包成 /appplay/<sid>/<vid> 反向代理，前端沿用既有 /dec 通道
//     （plan.decryptionKey = cenc_key_hex，由 ffmpeg -decryption_key 解密）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const appPlayUA = "Mozilla/5.0 (Linux; Android 12; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36"

type appPlayInfo struct {
	URL        string `json:"url"`
	Encrypted  bool   `json:"encrypted"`
	Codec      string `json:"codec"`
	Definition int    `json:"definition"`
	KeyHex     string `json:"key_hex"`
	CENCKeyHex string `json:"cenc_key_hex"`
	FetchedAt  time.Time
}

func sidecarBin() string {
	if v := strings.TrimSpace(os.Getenv("HONGGUO_RESOLVE_BIN")); v != "" {
		return v
	}
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "hg-resolve")
		if _, statErr := os.Stat(candidate); statErr == nil {
			return candidate
		}
	}
	return "hg-resolve"
}

func sidecarDeviceFile() string {
	if v := strings.TrimSpace(os.Getenv("HONGGUO_DEVICE_JSON")); v != "" {
		return v
	}
	if dataRoot != "" {
		return filepath.Join(dataRoot, "hg-device.json")
	}
	return "hg-device.json"
}

// resolveAppPlay 调侧车取一集播放地址（含派生后的 CENC 密钥）。
func resolveAppPlay(ctx context.Context, sid, vid string) (*appPlayInfo, error) {
	if sid == "" || vid == "" {
		return nil, errors.New("缺少剧集 id")
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, sidecarBin(), sid, vid, "--device", sidecarDeviceFile())
	cmd.Env = append(os.Environ(), "NO_COLOR=1")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var last string
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "{") {
			last = lines[i]
			break
		}
	}
	if last == "" {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("取流侧车无输出: %s", truncate(msg, 300))
	}
	var info struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		URL     string `json:"url"`
		Enc     bool   `json:"encrypted"`
		Codec   string `json:"codec"`
		Def     int    `json:"definition"`
		KeyHex  string `json:"key_hex"`
		CencKey string `json:"cenc_key_hex"`
	}
	if err := json.Unmarshal([]byte(last), &info); err != nil {
		return nil, fmt.Errorf("取流侧车返回异常: %v", err)
	}
	if !info.OK || info.URL == "" {
		reason := info.Error
		if reason == "" {
			reason = "未知错误"
		}
		return nil, fmt.Errorf("App 取流失败：%s", truncate(reason, 300))
	}
	if info.CencKey == "" && info.KeyHex != "" {
		info.CencKey = info.KeyHex
	}
	return &appPlayInfo{
		URL:        info.URL,
		Encrypted:  info.Enc,
		Codec:      info.Codec,
		Definition: info.Def,
		KeyHex:     info.KeyHex,
		CENCKeyHex: info.CencKey,
		FetchedAt:  time.Now(),
	}, nil
}

var (
	appPlayMu    sync.Mutex
	appPlayCache = map[string]*appPlayInfo{}
)

const appPlayTTL = 45 * time.Minute

func cachedAppPlay(sid, vid string) *appPlayInfo {
	appPlayMu.Lock()
	defer appPlayMu.Unlock()
	key := sid + "|" + vid
	if info, ok := appPlayCache[key]; ok && time.Since(info.FetchedAt) < appPlayTTL {
		return info
	}
	return nil
}

func storeAppPlay(sid, vid string, info *appPlayInfo) {
	appPlayMu.Lock()
	appPlayCache[sid+"|"+vid] = info
	appPlayMu.Unlock()
}

// handleAppPlay 反向代理红果 CDN 流：/appplay/<sid>/<vid>，透传 Range。
func handleAppPlay(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/appplay/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || !isDigits(parts[0]) || !isDigits(parts[1]) {
		http.Error(w, "bad appplay path", http.StatusBadRequest)
		return
	}
	sid, vid := parts[0], parts[1]
	info := cachedAppPlay(sid, vid)
	if info == nil {
		resolved, err := resolveAppPlay(r.Context(), sid, vid)
		if err != nil {
			log.Printf("appplay 取流失败 sid=%s vid=%s err=%v", sid, vid, err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		info = resolved
		storeAppPlay(sid, vid, info)
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, info.URL, nil)
	if err != nil {
		http.Error(w, "bad upstream request", http.StatusBadGateway)
		return
	}
	req.Header.Set("User-Agent", appPlayUA)
	if value := r.Header.Get("Range"); value != "" {
		req.Header.Set("Range", value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "上游请求失败: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if value := resp.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// appResolveFallback：core resolve 失败时，用 App 侧车构造与 core 同形的响应。
func appResolveFallback(ctx context.Context, payload map[string]any) ([]byte, error) {
	drama, _ := payload["drama"].(map[string]any)
	chapter, _ := payload["chapter"].(map[string]any)
	sid := strings.TrimPrefix(asString(drama["id"]), "hongguo:")
	vid := strings.TrimPrefix(asString(chapter["videoUrl"]), "hongguo-cenc://")
	info, err := resolveAppPlay(ctx, sid, vid)
	if err != nil {
		return nil, err
	}
	storeAppPlay(sid, vid, info)
	data := map[string]any{
		"url":           fmt.Sprintf("http://127.0.0.1:%d/appplay/%s/%s", listenPort, sid, vid),
		"quality":       info.Definition,
		"decryptionKey": info.CENCKeyHex,
		"codec":         info.Codec,
		"encrypted":     info.Encrypted,
		"source":        "app-v5",
		"session":       "app-" + sid + "-" + vid,
	}
	return json.Marshal(map[string]any{"ok": true, "data": data})
}

func truncate(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return text[:n]
}

func isDigits(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
