package core

// 红果 App 通道扫码登录：与业务接口同一套 App 签名通道（api 主机），
// 二维码用红果网页端 aid=513755 生成（扫码后得到可访问 App 接口的会话）。

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func hongguoAppQRParams() url.Values {
	extra := url.Values{}
	extra.Set("aid", "513755")
	extra.Set("app_name", "novelread")
	extra.Set("account_sdk_source", "web")
	extra.Set("is_from_ttaccountsdk", "1")
	extra.Set("passport_jssdk_version", "2.4.13")
	extra.Set("passport_jssdk_type", "normal")
	extra.Set("next", hongguoWebNext)
	extra.Set("account_sdk_source_info", hongguoAppSourceInfo())
	return extra
}

// hongguoAppSourceInfo 复刻竞品 qrSourceInfo 构造的浏览器指纹 JSON（passport web SDK）。
func hongguoAppSourceInfo() string {
	return `{"hardwareConcurrency":8,"webdriver":false,"chromedriver":false,"shelldriver":false,"plugins":[],"permissions":[{"name":"notifications","state":"prompt"}],"innerHeight":917,"innerWidth":1384,"outerHeight":1012,"outerWidth":1400}`
}

// hongguoAppQRStart 通过 App 签名通道获取扫码二维码。
func (engine *nativeEngine) hongguoAppQRStart(ctx context.Context) (map[string]any, error) {
	resp, err := engine.hongguoLoginRequest(ctx, http.MethodGet, "/passport/web/get_qrcode/", hongguoAppQRParams(), nil)
	if err != nil {
		return nil, err
	}
	m := normalizePassport(resp)
	code := toInt64(m["error_code"])
	if code != 0 {
		return map[string]any{"errorCode": code, "description": strOr(m, "description")}, nil
	}
	return map[string]any{
		"qrcode":      strOr(m, "qrcode"),
		"token":       strOr(m, "token"),
		"expireTime":  toInt64(m["expire_time"]),
		"copywriting": strOr(m, "copywriting"),
	}, nil
}

// hongguoAppQRPoll 轮询扫码状态；确认后跟随跳转并查询账号信息。
func (engine *nativeEngine) hongguoAppQRPoll(ctx context.Context, token string) (map[string]any, error) {
	if strings.TrimSpace(token) == "" {
		return map[string]any{"status": "error", "description": "二维码 token 为空"}, nil
	}
	extra := hongguoAppQRParams()
	extra.Set("token", token)
	resp, err := engine.hongguoLoginRequest(ctx, http.MethodGet, "/passport/web/check_qrconnect/", extra, nil)
	if err != nil {
		return nil, err
	}
	m := normalizePassport(resp)
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
	if redirect != "" {
		engine.followHongguoLoginRedirect(ctx, redirect)
	}
	account, err := engine.hongguoLoginAccount(ctx)
	if err != nil {
		return map[string]any{"status": status, "loggedIn": false, "description": err.Error()}, nil
	}
	uid := strOr(account, "user_id_str")
	if uid == "" {
		uid = strOr(account, "user_id")
	}
	name := strOr(account, "screen_name")
	if name == "" {
		name = strOr(account, "name")
	}
	if uid == "" && name == "" {
		return map[string]any{"status": status, "loggedIn": false}, nil
	}
	client := engine.downloader.hongguoClient()
	client.mu.Lock()
	saved := make(map[string]string, len(client.loginCookies))
	for k, v := range client.loginCookies {
		saved[k] = v
	}
	client.mu.Unlock()
	return map[string]any{
		"status":   "confirmed",
		"loggedIn": true,
		"uid":      uid,
		"name":     name,
		"avatar":   strOr(account, "avatar_url"),
		"source":   "app",
		"cookies":  saved,
	}, nil
}

// followHongguoLoginRedirect 用当前登录 cookie 访问跳转地址，捕获新下发的 Set-Cookie。
func (engine *nativeEngine) followHongguoLoginRedirect(ctx context.Context, target string) {
	client := engine.downloader.hongguoClient()
	client.mu.Lock()
	cookies := make(map[string]string, len(client.loginCookies))
	for k, v := range client.loginCookies {
		cookies[k] = v
	}
	client.mu.Unlock()
	ua := "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36"
	plain := &http.Client{Timeout: 15 * time.Second}
	for hop := 0; hop < 4 && target != ""; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return
		}
		req.Header.Set("User-Agent", ua)
		if len(cookies) > 0 {
			parts := make([]string, 0, len(cookies))
			for k, v := range cookies {
				parts = append(parts, k+"="+v)
			}
			req.Header.Set("Cookie", strings.Join(parts, "; "))
		}
		resp, err := plain.Do(req)
		if err != nil {
			return
		}
		for _, c := range resp.Cookies() {
			cookies[c.Name] = c.Value
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		target = ""
		if loc, err := resp.Location(); err == nil && loc != nil {
			target = loc.String()
		}
	}
	client.mu.Lock()
	if client.loginCookies == nil {
		client.loginCookies = map[string]string{}
	}
	for k, v := range cookies {
		client.loginCookies[k] = v
	}
	client.mu.Unlock()
}

func (engine *nativeEngine) persistHongguoAppLogin() {
	if engine == nil || engine.downloader == nil {
		return
	}
	client := engine.downloader.hongguoClient()
	client.mu.Lock()
	cookies := make(map[string]string, len(client.loginCookies))
	for k, v := range client.loginCookies {
		cookies[k] = v
	}
	client.mu.Unlock()
	if len(cookies) > 0 {
		engine.downloader.persistHongguoWebLogin(cookies)
	}
}
