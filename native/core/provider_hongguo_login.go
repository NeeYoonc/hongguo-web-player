package core

// 红果官方账号登录（passport）相关请求。
// 说明：登录接口与业务接口走同一套 App 签名通道（X-Gorgon / X-Argus / X-Ladon），
// 因此复用 hongguoAppRequest。这里只做请求编排，会话状态由调用方（网页端）保存。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

func (engine *nativeEngine) hongguoLoginRequest(ctx context.Context, method, path string, extra url.Values, payload any) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	return engine.downloader.hongguoAppRequest(ctx, method, path, extra, payload)
}

// normalizePassport 把 passport 响应 {"data":{...},"message":"..."} 拍平成一层，
// 便于前端统一按 error_code/description 处理。
func normalizePassport(resp map[string]any) map[string]any {
	if resp == nil {
		return nil
	}
	data, ok := resp["data"].(map[string]any)
	if !ok {
		return resp
	}
	out := make(map[string]any, len(data)+1)
	for k, v := range data {
		out[k] = v
	}
	if msg, ok := resp["message"].(string); ok && msg != "" {
		out["message"] = msg
	}
	return out
}

// hongguoLoginProbe 调试用：可指定方法/路径/额外 query/JSON body，便于探测 passport 参数组合。
type hongguoExtraHeadersKey struct{}

func (engine *nativeEngine) hongguoLoginProbe(ctx context.Context, method, path, queryJSON, body string, headers map[string]string) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		method = "POST"
	}
	extra := url.Values{}
	if q := strings.TrimSpace(queryJSON); q != "" {
		var m map[string]any
		if err := json.Unmarshal([]byte(q), &m); err != nil {
			return nil, fmt.Errorf("query JSON 解析失败: %w", err)
		}
		for key, value := range m {
			switch v := value.(type) {
			case string:
				extra.Set(key, v)
			case float64:
				extra.Set(key, strconv.FormatFloat(v, 'f', -1, 64))
			case bool:
				extra.Set(key, strconv.FormatBool(v))
			}
		}
	}
	var payload any
	if strings.TrimSpace(body) != "" {
		payload = json.RawMessage(body)
	}
	if len(headers) > 0 {
		ctx = context.WithValue(ctx, hongguoExtraHeadersKey{}, headers)
	}
	return engine.hongguoLoginRequest(ctx, method, path, extra, payload)
}

// hongguoLoginCookieHeader 把登录后拿到的 passport cookie 拼成 Cookie 头。
func (downloader *Downloader) hongguoLoginCookieHeader() string {
	client := downloader.hongguoClient()
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.loginCookies) == 0 {
		return ""
	}
	parts := make([]string, 0, len(client.loginCookies))
	for name, value := range client.loginCookies {
		parts = append(parts, name+"="+value)
	}
	sort.Strings(parts)
	return strings.Join(parts, "; ")
}

// captureHongguoLoginCookies 记录 passport 返回的 Set-Cookie（sessionid / x-tt-token 等）。
func (downloader *Downloader) captureHongguoLoginCookies(response *http.Response) {
	if response == nil {
		return
	}
	cookies := response.Cookies()
	if len(cookies) == 0 {
		return
	}
	client := downloader.hongguoClient()
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.loginCookies == nil {
		client.loginCookies = map[string]string{}
	}
	for _, cookie := range cookies {
		if cookie.Name == "" {
			continue
		}
		client.loginCookies[cookie.Name] = cookie.Value
	}
}

// hongguoLoginLogout 清空本进程内的登录 cookie（网页端 + 番茄官网 + App 通道）。
func (engine *nativeEngine) hongguoLoginLogout() map[string]any {
	if engine == nil || engine.downloader == nil {
		return map[string]any{"loggedOut": true}
	}
	engine.hongguoWebLogout()
	engine.hongguoFanqieLogout()
	return map[string]any{"loggedOut": true}
}

// hongguoLoginRaw 调试用：按指定路径与原始 JSON 发送登录类请求。
func (engine *nativeEngine) hongguoLoginRaw(ctx context.Context, path, body string) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	var payload any
	if strings.TrimSpace(body) != "" {
		payload = json.RawMessage(body)
	}
	return engine.downloader.hongguoAppRequest(ctx, "POST", path, nil, payload)
}

// hongguoLoginQRStart 获取扫码登录二维码（红果短剧网页端 passport，aid=513755）。
func (engine *nativeEngine) hongguoLoginQRStart(ctx context.Context) (map[string]any, error) {
	return engine.hongguoWebQRStart(ctx)
}

// hongguoLoginQRPoll 轮询扫码状态（红果短剧网页端）。
func (engine *nativeEngine) hongguoLoginQRPoll(ctx context.Context, token string) (map[string]any, error) {
	return engine.hongguoWebQRPoll(ctx, token)
}

// hongguoLoginSendCode 发送短信验证码（番茄官网 passport 网页通道，type=24）。
// hongguoLoginSMSType 红果 App 短信登录的 passport type（24=登录；1=注册、3=绑定、15=改密码、16=换绑）。
const hongguoLoginSMSType = "24"

// hongguoLoginSendCode 发送短信验证码（红果 App passport，mobile 明文放 query，type=24 登录）。
func (engine *nativeEngine) hongguoLoginSendCode(ctx context.Context, phone, region string) (map[string]any, error) {
	extra := url.Values{}
	extra.Set("mobile", phone)
	extra.Set("type", hongguoLoginSMSType)
	if region != "" {
		extra.Set("a_region", region)
	}
	resp, err := engine.hongguoLoginRequest(ctx, "POST", "/passport/mobile/send_code/v1/", extra, nil)
	return normalizePassport(resp), err
}

// hongguoLoginSMS 短信验证码登录（红果 App passport）。
func (engine *nativeEngine) hongguoLoginSMS(ctx context.Context, phone, code, region string) (map[string]any, error) {
	extra := url.Values{}
	extra.Set("mobile", phone)
	extra.Set("code", code)
	extra.Set("type", hongguoLoginSMSType)
	if region != "" {
		extra.Set("a_region", region)
	}
	resp, err := engine.hongguoLoginRequest(ctx, "POST", "/passport/mobile/sms_login/", extra, nil)
	return normalizePassport(resp), err
}

// hongguoLoginUserInfo 查询当前登录用户：优先红果 App 会话，失败回退番茄官网会话。
func (engine *nativeEngine) hongguoLoginUserInfo(ctx context.Context) (map[string]any, error) {
	app, err := engine.hongguoLoginAccount(ctx)
	if err == nil && app != nil {
		data := app
		if toInt64(data["error_code"]) == 0 {
			uid := ""
			if v, ok := data["user_id_str"].(string); ok && v != "" && v != "0" {
				uid = v
			} else if v, ok := data["user_id"]; ok {
				s := fmt.Sprint(v)
				if s != "0" {
					uid = s
				}
			}
			name, _ := data["screen_name"].(string)
			if name == "" {
				name, _ = data["name"].(string)
			}
			avatar, _ := data["avatar_url"].(string)
			if name == "account_info_error" {
				name = ""
			}
			if uid != "" || name != "" {
				return map[string]any{"loggedIn": true, "name": name, "avatar": avatar, "uid": uid, "source": "app"}, nil
			}
		}
	}
	if web, werr := engine.hongguoWebUserInfo(ctx); werr == nil && web != nil {
		return web, nil
	}
	fanqie, ferr := engine.hongguoFanqieUserInfo(ctx)
	if ferr == nil && fanqie != nil {
		if ok, _ := fanqie["loggedIn"].(bool); ok {
			fanqie["source"] = "fanqie"
			return fanqie, nil
		}
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"loggedIn": false}, nil
}

// hongguoLoginAccount 查询当前登录账号信息。
func (engine *nativeEngine) hongguoLoginAccount(ctx context.Context) (map[string]any, error) {
	resp, err := engine.hongguoLoginRequest(ctx, "GET", "/passport/account/info/v2/", nil, nil)
	return normalizePassport(resp), err
}

// hongguoEncodeMobile 把手机号按字节 XOR 0x05 后转 hex（与红果 App 的登录参数一致）。
func hongguoEncodeMobile(phone string) string {
	out := make([]byte, 0, len(phone)*2)
	const digits = "0123456789abcdef"
	for i := 0; i < len(phone); i++ {
		b := phone[i] ^ 0x05
		out = append(out, digits[b>>4], digits[b&0x0f])
	}
	return string(out)
}

// hongguoLoginCookie 读取已保存的登录 cookie（含 x-tt-token）。
func (downloader *Downloader) hongguoLoginCookie(name string) string {
	client := downloader.hongguoClient()
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.loginCookies[name]
}
