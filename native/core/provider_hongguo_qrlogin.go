package core

// 红果/番茄官网同源 passport 登录（扫码 + 手机验证码）。
//
// 说明：红果 App 的 aid=8662 并未开放网页扫码/短信登录类型，但番茄小说官网
// (fanqienovel.com) 的 passport 网页通道（aid=2503）是开放的，且与红果共用
// 字节统一账号体系。这里直连 fanqienovel.com/passport/web/*，不经过 App 签名通道。
//
// 关键参数（逆向自 fanqienovel 网页登录 SDK 行为）：
//   - 公共 query: aid=2503&app_name=novelapp&version_code=57700&device_platform=web&
//     channel=novel&sdk_version=1.6.1&passport_sdk_version=2.0.0&new_user=0
//   - 表单字段 mobile/type/code 需要「逐字节 ^5 转 hex」混淆
//   - 扫码轮询用 next + token；确认后跟随 redirect 拿 Set-Cookie
//   - 登录态校验: GET /api/user/info/v2 -> {data:{id,name,avatar,desc,isVip}}

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
	fanqieWebHost      = "https://fanqienovel.com"
	fanqieWebNext      = "https://fanqienovel.com/"
	fanqieUserInfoPath = "/api/user/info/v2"
	hongguoLoginFile   = "hongguo-login.json"
)

const fanqieWebUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"

var (
	fanqieOnce sync.Once
	fanqieJar  http.CookieJar
	fanqieHTTP *http.Client
)

func fanqieWeb() (*http.Client, http.CookieJar) {
	fanqieOnce.Do(func() {
		jar, _ := cookiejar.New(nil)
		fanqieJar = jar
		fanqieHTTP = &http.Client{Jar: jar, Timeout: 20 * time.Second}
	})
	return fanqieHTTP, fanqieJar
}

// fanqieObfuscate 复刻 passport 网页 SDK 的混淆：字符串逐字节 ^5 后转小写 hex（不补零）。
func fanqieObfuscate(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		fmt.Fprintf(&b, "%x", c^0x05)
	}
	return b.String()
}

func fanqiePassportQuery() url.Values {
	return url.Values{
		"aid":                  {"2503"},
		"app_name":             {"novelapp"},
		"version_code":         {"57700"},
		"device_platform":      {"web"},
		"channel":              {"novel"},
		"sdk_version":          {"1.6.1"},
		"passport_sdk_version": {"2.0.0"},
		"new_user":             {"0"},
	}
}

func fanqieWebDo(ctx context.Context, method, rawURL, form string) ([]byte, error) {
	client, _ := fanqieWeb()
	var body io.Reader
	if form != "" {
		body = strings.NewReader(form)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", fanqieWebUA)
	req.Header.Set("Referer", fanqieWebHost+"/")
	req.Header.Set("Origin", fanqieWebHost)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	if form != "" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接番茄登录服务失败: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("番茄登录服务返回 HTTP %d", resp.StatusCode)
	}
	return data, nil
}

func fanqieMap(data []byte) (map[string]any, error) {
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("解析登录响应失败: %w", err)
	}
	if d, ok := out["data"].(map[string]any); ok && len(d) > 0 {
		merged := map[string]any{}
		for k, v := range d {
			merged[k] = v
		}
		for k, v := range out {
			if k == "data" {
				continue
			}
			merged[k] = v
		}
		return merged, nil
	}
	return out, nil
}

func fanqieStr(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	switch v := m[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatInt(int64(v), 10)
	case json.Number:
		return v.String()
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

func fanqieInt(m map[string]any, key string) int64 {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		return n
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}

func fanqieErrText(m map[string]any) string {
	desc := fanqieStr(m, "description")
	if desc == "" {
		desc = fanqieStr(m, "message")
	}
	return desc
}

// fanqieCookies 取 fanqienovel.com 域下的全部 cookie。
func fanqieCookies() map[string]string {
	_, jar := fanqieWeb()
	if jar == nil {
		return nil
	}
	u, _ := url.Parse(fanqieWebHost + "/")
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

// fanqieUserInfo 校验登录态并返回昵称/头像。
func fanqieUserInfo(ctx context.Context) (map[string]any, error) {
	data, err := fanqieWebDo(ctx, http.MethodGet, fanqieWebHost+fanqieUserInfoPath, "")
	if err != nil {
		return nil, err
	}
	m, err := fanqieMap(data)
	if err != nil {
		return nil, err
	}
	id := fanqieInt(m, "id")
	if id <= 1 {
		return nil, nil
	}
	return map[string]any{
		"id":     strconv.FormatInt(id, 10),
		"name":   fanqieStr(m, "name"),
		"avatar": fanqieStr(m, "avatar"),
		"desc":   fanqieStr(m, "desc"),
		"isVip":  m["isVip"],
	}, nil
}

// persistHongguoLogin 把登录 cookie 写入 dataDir，重启后免重复登录。
func (downloader *Downloader) persistHongguoLogin(cookies map[string]string) {
	if downloader == nil || downloader.cfg.dataDir == "" || len(cookies) == 0 {
		return
	}
	body, err := json.MarshalIndent(map[string]any{"cookies": cookies, "savedAt": time.Now().Unix()}, "", "  ")
	if err != nil {
		return
	}
	_ = writeNativeCacheFile(filepath.Join(downloader.cfg.dataDir, hongguoLoginFile), body)
}

// loadHongguoLogin 启动时恢复上次登录 cookie。
func (downloader *Downloader) loadHongguoLogin() {
	if downloader == nil || downloader.cfg.dataDir == "" {
		return
	}
	body, err := os.ReadFile(filepath.Join(downloader.cfg.dataDir, hongguoLoginFile))
	if err != nil {
		return
	}
	var stored struct {
		Cookies map[string]string `json:"cookies"`
	}
	if err := json.Unmarshal(body, &stored); err != nil || len(stored.Cookies) == 0 {
		return
	}
	client := downloader.hongguoClient()
	client.mu.Lock()
	client.loginCookies = stored.Cookies
	client.mu.Unlock()
	// 同步写入 fanqie cookie jar，便于继续访问官网接口。
	_, jar := fanqieWeb()
	u, _ := url.Parse(fanqieWebHost + "/")
	cookies := make([]*http.Cookie, 0, len(stored.Cookies))
	for name, value := range stored.Cookies {
		cookies = append(cookies, &http.Cookie{Name: name, Value: value, Domain: "fanqienovel.com", Path: "/"})
	}
	if jar != nil && len(cookies) > 0 {
		jar.SetCookies(u, cookies)
	}
}

// adoptFanqieLogin 登录成功后把官网 cookie 写入 App 请求通道并持久化。
func (engine *nativeEngine) adoptFanqieLogin() map[string]string {
	cookies := fanqieCookies()
	if len(cookies) == 0 {
		return nil
	}
	client := engine.downloader.hongguoClient()
	client.mu.Lock()
	if client.loginCookies == nil {
		client.loginCookies = map[string]string{}
	}
	for name, value := range cookies {
		client.loginCookies[name] = value
	}
	merged := make(map[string]string, len(client.loginCookies))
	for name, value := range client.loginCookies {
		merged[name] = value
	}
	client.mu.Unlock()
	engine.downloader.persistHongguoLogin(merged)
	return cookies
}

// hongguoFanqieQRStart 获取扫码登录二维码（base64 data URL）。
func (engine *nativeEngine) hongguoFanqieQRStart(ctx context.Context) (map[string]any, error) {
	query := fanqiePassportQuery()
	query.Set("next", fanqieWebNext)
	raw := fanqieWebHost + "/passport/web/get_qrcode/?" + query.Encode()
	data, err := fanqieWebDo(ctx, http.MethodGet, raw, "")
	if err != nil {
		return nil, err
	}
	m, err := fanqieMap(data)
	if err != nil {
		return nil, err
	}
	if code := fanqieInt(m, "error_code"); code != 0 {
		return map[string]any{
			"errorCode":   code,
			"description": fanqieErrText(m),
		}, nil
	}
	token := fanqieStr(m, "token")
	qrcode := fanqieStr(m, "qrcode")
	if token == "" || qrcode == "" {
		return nil, errors.New("登录服务没有返回二维码")
	}
	return map[string]any{
		"token":      token,
		"qrcode":     "data:image/png;base64," + qrcode,
		"expireTime": fanqieInt(m, "expire_time"),
		"qrText":     fanqieStr(m, "qrcode_index_url"),
		"webName":    fanqieStr(m, "web_name"),
	}, nil
}

// hongguoFanqieQRPoll 轮询扫码状态；确认后跟随跳转建立会话。
func (engine *nativeEngine) hongguoFanqieQRPoll(ctx context.Context, token string) (map[string]any, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, errors.New("缺少二维码 token")
	}
	query := fanqiePassportQuery()
	query.Set("next", fanqieWebNext)
	query.Set("token", token)
	raw := fanqieWebHost + "/passport/web/check_qrconnect/?" + query.Encode()
	data, err := fanqieWebDo(ctx, http.MethodGet, raw, "")
	if err != nil {
		return nil, err
	}
	m, err := fanqieMap(data)
	if err != nil {
		return nil, err
	}
	status := fanqieStr(m, "status")
	redirect := fanqieStr(m, "redirect_url")
	if redirect == "" {
		redirect = fanqieStr(m, "redirectUrl")
	}
	if redirect == "" {
		redirect = fanqieStr(m, "url")
	}
	confirmed := redirect != "" || strings.Contains(strings.ToLower(status), "confirm") ||
		strings.Contains(strings.ToLower(status), "success") || strings.Contains(strings.ToLower(status), "done")
	if !confirmed {
		return map[string]any{"loggedIn": false, "status": status}, nil
	}
	// 跟随跳转（可能多次）建立会话。
	for _, u := range []string{redirect, fanqieWebNext} {
		if strings.TrimSpace(u) == "" {
			continue
		}
		_, _ = fanqieWebDo(ctx, http.MethodGet, u, "")
	}
	info, infoErr := fanqieUserInfo(ctx)
	if infoErr != nil || info == nil {
		return map[string]any{"loggedIn": false, "status": status, "needRetry": true}, nil
	}
	engine.adoptFanqieLogin()
	out := map[string]any{"loggedIn": true, "status": status}
	for k, v := range info {
		out[k] = v
	}
	return out, nil
}

// hongguoFanqieSendCode 发送登录短信验证码（type=24，混淆编码）。
func (engine *nativeEngine) hongguoFanqieSendCode(ctx context.Context, phone, region string) (map[string]any, error) {
	phone = strings.TrimSpace(phone)
	if len(phone) != 11 || !strings.HasPrefix(phone, "1") {
		return nil, errors.New("请输入正确的 11 位手机号")
	}
	if region == "" {
		region = "86"
	}
	form := "mix_mode=1&fixed_mix_mode=1" +
		"&mobile=" + url.QueryEscape(fanqieObfuscate(phone)) +
		"&type=" + url.QueryEscape(fanqieObfuscate("24")) +
		"&a_region=" + url.QueryEscape(region) +
		"&request_id=" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	raw := fanqieWebHost + "/passport/web/send_code/?" + fanqiePassportQuery().Encode()
	data, err := fanqieWebDo(ctx, http.MethodPost, raw, form)
	if err != nil {
		return nil, err
	}
	m, err := fanqieMap(data)
	if err != nil {
		return nil, err
	}
	code := fanqieInt(m, "error_code")
	if code != 0 {
		return map[string]any{"errorCode": code, "description": fanqieErrText(m)}, nil
	}
	ticket := fanqieStr(m, "mobile_ticket")
	if ticket == "" {
		return nil, errors.New("验证码已发送，但缺少票据，请重试")
	}
	return map[string]any{"sent": true, "mobileTicket": ticket, "retryTime": 60}, nil
}

// hongguoFanqieSMSLogin 验证码登录（成功后建立会话并校验用户信息）。
func (engine *nativeEngine) hongguoFanqieSMSLogin(ctx context.Context, phone, code, region string) (map[string]any, error) {
	phone = strings.TrimSpace(phone)
	code = strings.TrimSpace(code)
	if len(phone) != 11 || !strings.HasPrefix(phone, "1") {
		return nil, errors.New("请输入正确的 11 位手机号")
	}
	if len(code) < 4 || len(code) > 8 {
		return nil, errors.New("请输入正确的验证码")
	}
	if region == "" {
		region = "86"
	}
	form := "mix_mode=1&fixed_mix_mode=1" +
		"&mobile=" + url.QueryEscape(fanqieObfuscate(phone)) +
		"&code=" + url.QueryEscape(fanqieObfuscate(code)) +
		"&a_region=" + url.QueryEscape(region)
	raw := fanqieWebHost + "/passport/web/sms_login/?" + fanqiePassportQuery().Encode()
	data, err := fanqieWebDo(ctx, http.MethodPost, raw, form)
	if err != nil {
		return nil, err
	}
	m, err := fanqieMap(data)
	if err != nil {
		return nil, err
	}
	if code := fanqieInt(m, "error_code"); code != 0 {
		return map[string]any{"errorCode": code, "description": fanqieErrText(m)}, nil
	}
	info, infoErr := fanqieUserInfo(ctx)
	if infoErr != nil || info == nil {
		return nil, errors.New("登录成功但会话建立失败，请重试")
	}
	engine.adoptFanqieLogin()
	out := map[string]any{"loggedIn": true}
	for k, v := range info {
		out[k] = v
	}
	return out, nil
}

// fanqieClearCookies 重置番茄官网 cookie jar（登出用）。
func fanqieClearCookies() {
	jar, _ := cookiejar.New(nil)
	fanqieJar = jar
	fanqieHTTP = &http.Client{Jar: jar, Timeout: 20 * time.Second}
}

// hongguoFanqieLogout 登出并清理本地持久化的登录 cookie。
func (engine *nativeEngine) hongguoFanqieLogout() map[string]any {
	fanqieClearCookies()
	if engine != nil && engine.downloader != nil {
		if client := engine.downloader.hongguoClient(); client != nil {
			client.mu.Lock()
			client.loginCookies = nil
			client.mu.Unlock()
		}
		if engine.downloader.cfg.dataDir != "" {
			_ = os.Remove(filepath.Join(engine.downloader.cfg.dataDir, hongguoLoginFile))
		}
	}
	return map[string]any{"loggedOut": true}
}

// hongguoFanqieUserInfo 查询当前登录用户（未登录返回 null）。
func (engine *nativeEngine) hongguoFanqieUserInfo(ctx context.Context) (map[string]any, error) {
	info, err := fanqieUserInfo(ctx)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return map[string]any{"loggedIn": false}, nil
	}
	out := map[string]any{"loggedIn": true}
	for k, v := range info {
		out[k] = v
	}
	return out, nil
}
