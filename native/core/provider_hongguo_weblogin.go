package core

// 红果短剧网页端（hongguoduanju.com）passport 扫码登录。
//
// 红果 App 的 aid=8662 不开放网页登录，但红果短剧网页端本身有独立的 passport 通道：
//   - host: https://hongguoduanju.com
//   - aid: 513755（网页端应用 id）
//   - GET /passport/web/get_qrcode/      -> data{qrcode(dataURL), token, expire_time, copywriting}
//   - GET /passport/web/check_qrconnect/ -> data{status, redirect_url?}
//   - GET /passport/account/info/v2/     -> data{error_code, user_id_str, screen_name, avatar_url, ...}
//
// 该通道不需要 a_bogus / msToken 签名（实测最小参数即可），只需同源 Referer 与 cookie jar。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	hongguoWebHost      = "https://hongguoduanju.com"
	hongguoWebNext      = "https://hongguoduanju.com/"
	hongguoWebAID       = "513755"
	hongguoWebLoginFile = "hongguo-web-login.json"
)

const hongguoWebUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"

var (
	hongguoWebOnce   sync.Once
	hongguoWebJar    http.CookieJar
	hongguoWebHTTP   *http.Client
	hongguoWebMu     sync.Mutex
	hongguoWebCookie map[string]string
)

func hongguoWeb() (*http.Client, http.CookieJar) {
	hongguoWebOnce.Do(func() {
		jar, _ := cookiejar.New(nil)
		hongguoWebJar = jar
		hongguoWebHTTP = &http.Client{Jar: jar, Timeout: 20 * time.Second}
	})
	return hongguoWebHTTP, hongguoWebJar
}

// hongguoWebQuery 网页端 passport 公共参数。
func hongguoWebQuery() url.Values {
	q := url.Values{}
	q.Set("aid", hongguoWebAID)
	q.Set("language", "zh")
	q.Set("passport_jssdk_version", "2.4.13")
	q.Set("passport_jssdk_type", "normal")
	q.Set("is_from_ttaccountsdk", "1")
	q.Set("account_sdk_source", "web")
	q.Set("next", hongguoWebNext)
	return q
}

func hongguoWebDo(ctx context.Context, method, path string, extra url.Values) (map[string]any, error) {
	client, _ := hongguoWeb()
	q := hongguoWebQuery()
	for k, vs := range extra {
		for _, v := range vs {
			q.Set(k, v)
		}
	}
	rawURL := hongguoWebHost + path
	if method == http.MethodGet {
		rawURL += "?" + q.Encode()
	}
	var body io.Reader
	if method != http.MethodGet {
		body = strings.NewReader(q.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", hongguoWebUA)
	req.Header.Set("Referer", hongguoWebNext)
	req.Header.Set("Accept", "application/json, text/javascript")
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("红果网页 passport 响应解析失败: %w", err)
	}
	if d, ok := out["data"].(map[string]any); ok {
		for k, v := range d {
			out[k] = v
		}
	}
	return out, nil
}

func hongguoWebCookies() map[string]string {
	_, jar := hongguoWeb()
	if jar == nil {
		return nil
	}
	u, _ := url.Parse(hongguoWebHost + "/")
	cookies := jar.Cookies(u)
	if len(cookies) == 0 {
		return nil
	}
	out := make(map[string]string, len(cookies))
	for _, c := range cookies {
		out[c.Name] = c.Value
	}
	return out
}

// hongguoWebUserInfo 用网页会话查询账号信息。
func hongguoWebUserInfo(ctx context.Context) (map[string]any, error) {
	m, err := hongguoWebDo(ctx, http.MethodGet, "/passport/account/info/v2/", nil)
	if err != nil {
		return nil, err
	}
	if code := toInt64(m["error_code"]); code != 0 {
		return nil, nil
	}
	uid := ""
	if v, ok := m["user_id_str"].(string); ok && v != "" {
		uid = v
	} else if v, ok := m["user_id"]; ok {
		uid = fmt.Sprint(v)
	}
	name, _ := m["screen_name"].(string)
	if name == "" {
		name, _ = m["name"].(string)
	}
	avatar, _ := m["avatar_url"].(string)
	if avatar == "" {
		avatar, _ = m["avatar_thumb"].(string)
	}
	if uid == "" && name == "" {
		return nil, nil
	}
	return map[string]any{"loggedIn": true, "name": name, "avatar": avatar, "uid": uid, "source": "web"}, nil
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case json.Number:
		i, _ := n.Int64()
		return i
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	}
	return 0
}

// persistHongguoWebLogin 把网页登录 cookie 写入 dataDir，重启后免重复登录。
func (downloader *Downloader) persistHongguoWebLogin(cookies map[string]string) {
	// 会话保存在浏览器 localStorage（X-HG-Cookies 头回传），宿主侧不再落盘。
}

// loadHongguoWebLogin 启动时恢复网页登录 cookie。
func (downloader *Downloader) loadHongguoWebLogin() {
	if downloader == nil || downloader.cfg.dataDir == "" {
		return
	}
	body, err := os.ReadFile(filepath.Join(downloader.cfg.dataDir, hongguoWebLoginFile))
	if err != nil {
		return
	}
	var stored struct {
		Cookies map[string]string `json:"cookies"`
	}
	if err := json.Unmarshal(body, &stored); err != nil || len(stored.Cookies) == 0 {
		return
	}
	_, jar := hongguoWeb()
	u, _ := url.Parse(hongguoWebHost + "/")
	cookies := make([]*http.Cookie, 0, len(stored.Cookies))
	for name, value := range stored.Cookies {
		cookies = append(cookies, &http.Cookie{Name: name, Value: value, Domain: "hongguoduanju.com", Path: "/"})
	}
	if jar != nil && len(cookies) > 0 {
		jar.SetCookies(u, cookies)
	}
	// 同步到 App 请求通道：红果 App 接口接受网页 passport 会话。
	if client := downloader.hongguoClient(); client != nil {
		client.mu.Lock()
		if client.loginCookies == nil {
			client.loginCookies = map[string]string{}
		}
		for k, v := range stored.Cookies {
			client.loginCookies[k] = v
		}
		client.mu.Unlock()
	}
	// 迁移：宿主文件读入内存后立即删除，会话改由浏览器保存。
	_ = os.Remove(filepath.Join(downloader.cfg.dataDir, hongguoWebLoginFile))
}

// hongguoWebSetCookies 把浏览器携带的会话 cookie 写入网页端 cookie jar。
func hongguoWebSetCookies(cookies map[string]string) {
	if len(cookies) == 0 {
		return
	}
	_, jar := hongguoWeb()
	if jar == nil {
		return
	}
	u, _ := url.Parse(hongguoWebHost + "/")
	list := make([]*http.Cookie, 0, len(cookies))
	for name, value := range cookies {
		list = append(list, &http.Cookie{Name: name, Value: value, Domain: "hongguoduanju.com", Path: "/"})
	}
	jar.SetCookies(u, list)
}

func hongguoWebClearCookies() {
	hongguoWebMu.Lock()
	defer hongguoWebMu.Unlock()
	jar, _ := cookiejar.New(nil)
	hongguoWebJar = jar
	hongguoWebHTTP = &http.Client{Jar: jar, Timeout: 20 * time.Second}
	hongguoWebCookie = nil
}

// hongguoWebQRStart 获取红果网页端扫码登录二维码。
func (engine *nativeEngine) hongguoWebQRStart(ctx context.Context) (map[string]any, error) {
	m, err := hongguoWebDo(ctx, http.MethodGet, "/passport/web/get_qrcode/", nil)
	if err != nil {
		return nil, err
	}
	code := toInt64(m["error_code"])
	if code != 0 {
		return map[string]any{
			"errorCode":   code,
			"description": strOr(m, "description"),
		}, nil
	}
	return map[string]any{
		"qrcode":     strOr(m, "qrcode"),
		"token":      strOr(m, "token"),
		"expireTime": toInt64(m["expire_time"]),
		"copywriting": strOr(m, "copywriting"),
	}, nil
}

// hongguoWebQRPoll 轮询扫码状态；确认后跟随 redirect 捕获会话 cookie 并查询账号。
func (engine *nativeEngine) hongguoWebQRPoll(ctx context.Context, token string) (map[string]any, error) {
	if token == "" {
		return map[string]any{"status": "error", "description": "二维码 token 为空"}, nil
	}
	extra := url.Values{}
	extra.Set("token", token)
	m, err := hongguoWebDo(ctx, http.MethodGet, "/passport/web/check_qrconnect/", extra)
	if err != nil {
		return nil, err
	}
	code := toInt64(m["error_code"])
	if code != 0 {
		return map[string]any{"status": "error", "errorCode": code, "description": strOr(m, "description")}, nil
	}
	status := strings.ToLower(strOr(m, "status"))
	redirect := strOr(m, "redirect_url")
	confirmed := redirect != "" || status == "confirmed" || status == "confirm" || status == "success" || status == "done" || status == "ok"
	if !confirmed {
		return map[string]any{"status": status, "loggedIn": false}, nil
	}
	// 确认后访问一次首页/redirect，让 passport 写入 session cookie。
	client, _ := hongguoWeb()
	if redirect != "" {
		if req, err := http.NewRequestWithContext(ctx, http.MethodGet, redirect, nil); err == nil {
			req.Header.Set("User-Agent", hongguoWebUA)
			if resp, err := client.Do(req); err == nil {
				resp.Body.Close()
			}
		}
	}
	homeReq, err := http.NewRequestWithContext(ctx, http.MethodGet, hongguoWebNext, nil)
	if err == nil {
		homeReq.Header.Set("User-Agent", hongguoWebUA)
		if resp, err := client.Do(homeReq); err == nil {
			resp.Body.Close()
		}
	}
	info, err := hongguoWebUserInfo(ctx)
	if err != nil || info == nil {
		return map[string]any{"status": status, "loggedIn": false}, nil
	}
	cookies := hongguoWebCookies()
	if len(cookies) > 0 {
		engine.downloader.persistHongguoWebLogin(cookies)
		// 同步到 App 请求通道，供业务接口复用。
		appClient := engine.downloader.hongguoClient()
		appClient.mu.Lock()
		if appClient.loginCookies == nil {
			appClient.loginCookies = map[string]string{}
		}
		for k, v := range cookies {
			appClient.loginCookies[k] = v
		}
		appClient.mu.Unlock()
	}
	info["status"] = status
	return info, nil
}

func (engine *nativeEngine) hongguoWebUserInfo(ctx context.Context) (map[string]any, error) {
	return hongguoWebUserInfo(ctx)
}

// hongguoWebLogout 清除网页端登录态。
func (engine *nativeEngine) hongguoWebLogout() map[string]any {
	hongguoWebClearCookies()
	if engine != nil && engine.downloader != nil && engine.downloader.cfg.dataDir != "" {
		_ = os.Remove(filepath.Join(engine.downloader.cfg.dataDir, hongguoWebLoginFile))
	}
	client := engine.downloader.hongguoClient()
	client.mu.Lock()
	client.loginCookies = nil
	client.mu.Unlock()
	return map[string]any{"loggedOut": true}
}

func strOr(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	if v, ok := m[key]; ok && v != nil {
		return fmt.Sprint(v)
	}
	return ""
}

var _ = errors.New

// hongguoExportSession 把宿主内存中的登录 cookie 交给浏览器保存，并清空宿主副本。
func (engine *nativeEngine) hongguoExportSession() (map[string]any, error) {
	empty := map[string]any{"cookies": map[string]string{}}
	if engine == nil || engine.downloader == nil {
		return empty, nil
	}
	client := engine.downloader.hongguoClient()
	if client == nil {
		return empty, nil
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	out := make(map[string]string, len(client.loginCookies))
	for k, v := range client.loginCookies {
		out[k] = v
	}
	client.loginCookies = nil
	hongguoWebClearCookies()
	return map[string]any{"cookies": out}, nil
}
