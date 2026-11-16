// 红果短剧 Web 客户端：复用 guoapp native/core 的取流能力，提供浏览器 UI。
// 只做三件事：/api 转发 core.NativeRequest；/rs/ 反向代理本地流服务；/ 提供静态页面。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"duanjuapp/native/core"
)

var (
	listenPort int
	sequence   atomic.Int64
	stream   = &http.Client{Transport: &http.Transport{
		Proxy:                 nil,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: 2 * time.Second,
	}}
)

func main() {
	addr := flag.String("addr", "0.0.0.0:8788", "监听地址")
	data := flag.String("data", "./data", "数据目录")
	web := flag.String("web", "./web", "静态页面目录")
	cache := flag.String("cache", "./cache", "转码/解密缓存目录")
	flag.Parse()
	if _, portText, splitErr := net.SplitHostPort(*addr); splitErr == nil {
		if parsedPort, convErr := strconv.Atoi(portText); convErr == nil {
			listenPort = parsedPort
		}
	}
	dataRoot = *data
	webDir = *web

	dataDir, err := filepath.Abs(*data)
	if err != nil {
		log.Fatalf("数据目录无效: %v", err)
	}
	webDir, err := filepath.Abs(*web)
	if err != nil {
		log.Fatalf("页面目录无效: %v", err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		log.Fatalf("创建数据目录失败: %v", err)
	}
	cacheDir, err = filepath.Abs(*cache)
	if err != nil {
		log.Fatalf("缓存目录无效: %v", err)
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		log.Fatalf("创建缓存目录失败: %v", err)
	}

	initReq, _ := json.Marshal(map[string]any{"action": "initialize", "directory": dataDir})
	initResp := core.NativeRequest(string(initReq))
	var result struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(initResp), &result); err != nil || !result.OK {
		log.Fatalf("核心初始化失败: %s (%v)", initResp, err)
	}
	log.Printf("核心初始化成功: %s", initResp)
	sequence.Store(time.Now().UnixMilli())

	if err := initUsers(dataDir); err != nil {
		log.Fatalf("加载用户数据失败: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api", handleAPI)
	mux.HandleFunc("/auth/", handleAuth)
	mux.HandleFunc("/user/", handleUserData)
	mux.HandleFunc("/rs/", handleStream)
	mux.HandleFunc("/probe", handleProbe)
	mux.HandleFunc("/dec", handleDec)
	mux.HandleFunc("/appplay/", handleAppPlay)
	mux.HandleFunc("/tc", handleTranscode)
	mux.HandleFunc("/clientlog", handleClientLog)
	mux.HandleFunc("/comments", handleComments)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "ok")
	})
	mux.Handle("/", spaHandler(webDir))

	server := &http.Server{
		Addr:              *addr,
		Handler:           withLogging(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("红果短剧 Web 客户端已启动: http://%s （数据目录 %s）", *addr, dataDir)
	log.Fatal(server.ListenAndServe())
}

// handleAPI 把前端 JSON 请求转给 core.NativeRequest。
var (
	dataRoot string
	webDir   string
)

func fetchDanmaku(vid, sid string, startMs, durMs int64, cookies map[string]string) ([]map[string]any, int, error) {
	if vid == "" || sid == "" {
		return nil, 0, errors.New("缺少剧集参数")
	}
	items := []map[string]any{}
	seen := map[string]bool{}
	script := filepath.Join(webDir, "..", "signer", "fetch_danmaku.mjs")
	login := filepath.Join(dataRoot, "hongguo-web-login.json")
	if len(cookies) > 0 {
		if tmp, terr := os.CreateTemp("", "hg-dm-*.json"); terr == nil {
			payload := map[string]any{"cookies": cookies, "token": "", "device": map[string]any{}}
			data, _ := json.Marshal(payload)
			tmp.Write(data)
			tmp.Close()
			login = tmp.Name()
			defer os.Remove(login)
		}
	}
	if durMs <= 0 || durMs > 1200000 {
		durMs = 300000
	}
	emptyRun := 0
	for start := int64(0); start < durMs && start < 1200000; start += 30000 {
		winEnd := start + 30000
		args := []string{script, vid, sid, strconv.FormatInt(start, 10), strconv.FormatInt(winEnd, 10), login, ""}
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		out, err := exec.CommandContext(ctx, "node", args...).Output()
		cancel()
		if err != nil {
			if len(items) > 0 {
				break
			}
			return nil, 0, errors.New("弹幕服务暂不可用")
		}
		var res struct {
			Code int `json:"code"`
			Data struct {
				List []struct {
					Comment struct {
						ID     string `json:"comment_id"`
						Common struct {
							Content struct {
								Text string `json:"text"`
							} `json:"content"`
						} `json:"common"`
						Expand struct {
							OffsetTime int64 `json:"offset_time"`
						} `json:"expand"`
					} `json:"comment"`
				} `json:"data_list"`
			} `json:"data"`
		}
		if err := json.Unmarshal(out, &res); err != nil || res.Code != 0 {
			if len(items) > 0 {
				break
			}
			return nil, 0, errors.New("弹幕读取失败")
		}
		got := 0
		for _, it := range res.Data.List {
			text := it.Comment.Common.Content.Text
			if text == "" || seen[it.Comment.ID] {
				continue
			}
			seen[it.Comment.ID] = true
			items = append(items, map[string]any{"id": it.Comment.ID, "text": text, "timeMs": it.Comment.Expand.OffsetTime})
			got++
		}
		if got == 0 {
			emptyRun++
		} else {
			emptyRun = 0
		}
		if emptyRun >= 2 {
			break
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["timeMs"].(int64) < items[j]["timeMs"].(int64) })
	return items, len(items), nil
}

func handleAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只支持 POST"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求读取失败"})
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求格式无效"})
		return
	}
	// 弹幕读取走 danmu_api 的签名实现（node），绕开 core 的评论签名问题。
	if act, _ := payload["action"].(string); act == "danmaku" {
		vid, _ := payload["session"].(string)
		sid, _ := payload["query"].(string)
		startMs, _ := payload["startMs"].(float64)
		durMs, _ := payload["durationMs"].(float64)
		cookieMap := map[string]string{}
		if cm, ok := payload["cookies"].(map[string]any); ok {
			for k, v := range cm {
				if sv, ok := v.(string); ok && sv != "" {
					cookieMap[k] = sv
				}
			}
		}
		items, total, derr := fetchDanmaku(vid, sid, int64(startMs), int64(durMs), cookieMap)
		log.Printf("danmaku sid=%s vid=%s cookies=%d items=%d total=%d err=%v", sid, vid, len(cookieMap), len(items), total, derr)
		if derr != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "error": derr.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "data": map[string]any{
			"items": items, "startMs": int64(startMs), "nextMs": int64(startMs + durMs), "total": total,
		}})
		return
	}
	// 播放/弹幕会话要求 sequence 单调递增，由服务端统一分配，前端无需关心。
	switch payload["action"] {
	case "resolve", "fallback", "cancelPlayback", "danmaku", "preload":
		seq := sequence.Add(1)
		payload["sequence"] = seq
		if payload["action"] == "danmaku" || payload["action"] == "preload" {
			if v, _ := payload["session"].(string); v == "" {
				if payload["action"] == "danmaku" {
					payload["session"] = "web-danmaku"
				} else {
					payload["session"] = fmt.Sprintf("prefetch-%d", seq)
				}
			}
		}
		body, _ = json.Marshal(payload)
	}
	start := time.Now()
	action, _ := payload["action"].(string)
	var res struct {
		Ok    bool   `json:"ok"`
		Error string `json:"error"`
	}
	response := ""

	// 预取：官方 App 通道预热下一集地址（前端用的是 action=preload）
	if action == "preload" && sidecarReady() {
		if out, ok := appPreload(r.Context(), payload); ok {
			response = string(out)
		}
	}

	// 侧车优先：旧通道对已收紧的接口要重试 2.5~4s 才失败，直接走官方 App 通道
	if response == "" && (action == "resolve" || action == "fallback") && sidecarReady() {
		if plan, ferr := appResolveFallback(r.Context(), payload); ferr == nil {
			response = string(plan)
		} else {
			log.Printf("resolve sidecar-first 失败，回退 core: %v", ferr)
		}
	}

	if response == "" {
		response = core.NativeRequest(string(body))
		_ = json.Unmarshal([]byte(response), &res)
		if !res.Ok && (action == "resolve" || action == "fallback") && sidecarReady() {
			if fallback, ferr := appResolveFallback(r.Context(), payload); ferr == nil {
				response = string(fallback)
			} else {
				log.Printf("resolve fallback=app-v5 失败: %v", ferr)
			}
		}
	}
	_ = json.Unmarshal([]byte(response), &res)
	log.Printf("api action=%s ok=%v err=%q %s", action, res.Ok, res.Error, time.Since(start).Round(time.Millisecond))
	if strings.HasPrefix(action, "hgLogin") {
		if len(response) > 600 {
			log.Printf("login action=%s resp=%s", action, response[:600])
		} else {
			log.Printf("login action=%s resp=%s", action, response)
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, response)
}

// handleStream 反向代理 core 的本地流服务：/rs/<port>/<token>/<asset>。
// m3u8 里的绝对地址会改写成 /rs/<port>/...，使浏览器只访问本服务。
func handleStream(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/rs/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[1] == "" {
		http.Error(w, "bad stream path", http.StatusBadRequest)
		return
	}
	port, err := strconv.Atoi(parts[0])
	if err != nil || port <= 0 || port > 65535 {
		http.Error(w, "bad stream port", http.StatusBadRequest)
		return
	}
	if strings.Contains(parts[1], "..") || strings.ContainsAny(parts[1], "\x00\r\n") {
		http.Error(w, "bad stream path", http.StatusBadRequest)
		return
	}
	target := fmt.Sprintf("http://127.0.0.1:%d/%s", port, parts[1])
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	request, err := http.NewRequestWithContext(r.Context(), r.Method, target, nil)
	if err != nil {
		http.Error(w, "bad stream request", http.StatusBadRequest)
		return
	}
	if value := r.Header.Get("Range"); value != "" {
		request.Header.Set("Range", value)
	}
	if value := r.Header.Get("If-Modified-Since"); value != "" {
		request.Header.Set("If-Modified-Since", value)
	}
	if value := r.Header.Get("If-None-Match"); value != "" {
		request.Header.Set("If-None-Match", value)
	}
	response, err := stream.Do(request)
	if err != nil {
		http.Error(w, "stream error", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()

	contentType := response.Header.Get("Content-Type")
	isPlaylist := strings.Contains(strings.ToLower(contentType), "mpegurl") ||
		strings.HasSuffix(strings.ToLower(parts[1]), ".m3u8")
	for _, header := range []string{"Content-Type", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag", "Cache-Control"} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	if !isPlaylist {
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		http.Error(w, "stream read error", http.StatusBadGateway)
		return
	}
	rewritten := strings.ReplaceAll(string(body), fmt.Sprintf("http://127.0.0.1:%d", port), "/rs/"+parts[0])
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Content-Length", strconv.Itoa(len(rewritten)))
	w.WriteHeader(response.StatusCode)
	_, _ = io.WriteString(w, rewritten)
}

// spaHandler 提供静态文件；找不到文件时回退到 index.html。
func spaHandler(root string) http.Handler {
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			files.ServeHTTP(w, r)
			return
		}
		candidate := filepath.Join(root, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			// ffmpeg.wasm 体积大且基本不变，长缓存；其余前端资源回源校验。
			if strings.HasPrefix(r.URL.Path, "/assets/ffmpeg/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// handleClientLog 收集前端诊断日志，便于在 NAS 上排查浏览器端播放问题。
func handleClientLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	msg := strings.ReplaceAll(string(body), "\n", " ")
	log.Printf("clientlog %s", msg)
	w.WriteHeader(http.StatusNoContent)
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		next.ServeHTTP(w, r)
		if p := r.URL.Path; p == "/" || p == "/dec" || p == "/tc" || p == "/probe" {
			log.Printf("%s %s %s ua=%q", r.Method, p, time.Since(start).Round(time.Millisecond), r.UserAgent())
		} else {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
