package core

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const hongguoAppBaseURL = "https://api5-normal-sinfonlineb.fqnovel.com"

const hongguoAppUserAgent = "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)"

type hongguoCatalogCursor struct {
	Offset        int       `json:"offset"`
	SessionID     string    `json:"sessionId,omitempty"`
	LastID        string    `json:"lastId,omitempty"`
	PageSignature string    `json:"pageSignature,omitempty"`
	Initialized   bool      `json:"initialized"`
	Exhausted     bool      `json:"exhausted"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type hongguoCatalogState struct {
	Version          int                             `json:"version"`
	DeviceID         string                          `json:"deviceId"`
	InstallID        string                          `json:"installId"`
	Registered       bool                            `json:"registered,omitempty"`
	HelperDeviceID   string                          `json:"helperDeviceId,omitempty"`
	HelperInstallID  string                          `json:"helperInstallId,omitempty"`
	HelperRegistered bool                            `json:"helperRegistered,omitempty"`
	Feeds            map[string]hongguoCatalogCursor `json:"feeds"`
}

type hongguoAppClient struct {
	mu                  sync.Mutex
	catalogMu           sync.Mutex
	deviceMu            sync.Mutex
	registerPausedUntil time.Time
	registerPauseErr    error
	baseURL             string
	state               hongguoCatalogState
	details             map[string]hongguoDetailEntry
	pending             map[string]*hongguoDetailCall
	searches            map[string]hongguoSearchEntry
	searchPending       map[string]*hongguoSearchCall
	searchIDs           map[string]string
	suggestions         map[string]hongguoSuggestionEntry
	suggestPending      map[string]*hongguoSuggestionCall
	danmaku             map[string]hongguoDanmakuCacheEntry
	danmakuPending      map[string]*hongguoDanmakuCall
	tagCursors          map[string]hongguoTagCursor
	loginCookies        map[string]string
}

func (downloader *Downloader) hongguoClient() *hongguoAppClient {
	downloader.hongguoOnce.Do(func() {
		downloader.hongguo = &hongguoAppClient{
			baseURL: hongguoAppBaseURL,
			state: hongguoCatalogState{Version: 1, DeviceID: newHongguoDeviceID(), InstallID: newHongguoDeviceID(),
				HelperDeviceID: newHongguoDeviceID(), HelperInstallID: newHongguoDeviceID(), Feeds: map[string]hongguoCatalogCursor{}},
			details: map[string]hongguoDetailEntry{}, pending: map[string]*hongguoDetailCall{},
			searches: map[string]hongguoSearchEntry{}, searchPending: map[string]*hongguoSearchCall{}, searchIDs: map[string]string{},
			suggestions: map[string]hongguoSuggestionEntry{}, suggestPending: map[string]*hongguoSuggestionCall{},
			tagCursors: map[string]hongguoTagCursor{},
		}
	})
	return downloader.hongguo
}

func cloneHongguoCatalogState(state *hongguoCatalogState) *hongguoCatalogState {
	if state == nil {
		return nil
	}
	cloned := *state
	cloned.Feeds = make(map[string]hongguoCatalogCursor, len(state.Feeds))
	for name, cursor := range state.Feeds {
		cloned.Feeds[name] = cursor
	}
	return &cloned
}

func (downloader *Downloader) restoreHongguoCatalog(state *hongguoCatalogState) {
	if state == nil || state.Version != 1 || !hongguoNumericID.MatchString(state.DeviceID) || !hongguoNumericID.MatchString(state.InstallID) {
		return
	}
	cloned := cloneHongguoCatalogState(state)
	if !hongguoNumericID.MatchString(cloned.HelperDeviceID) || !hongguoNumericID.MatchString(cloned.HelperInstallID) {
		cloned.HelperDeviceID, cloned.HelperInstallID, cloned.HelperRegistered = newHongguoDeviceID(), newHongguoDeviceID(), false
	}
	for name, cursor := range cloned.Feeds {
		known := false
		for _, genre := range hongguoAppGenres {
			known = known || name == genre.key || name == "category:"+genre.key
		}
		if !known || !cursor.Initialized || cursor.Offset < 0 || cursor.Offset > 1_000_000 || len(cursor.SessionID) > 4096 || len(cursor.LastID) > 256 || len(cursor.PageSignature) > 64 {
			delete(cloned.Feeds, name)
		}
	}
	client := downloader.hongguoClient()
	client.catalogMu.Lock()
	defer client.catalogMu.Unlock()
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.state.Feeds) == 0 {
		client.state = *cloned
	}
}

func (downloader *Downloader) hongguoCatalogSnapshot() *hongguoCatalogState {
	client := downloader.hongguoClient()
	client.mu.Lock()
	defer client.mu.Unlock()
	return cloneHongguoCatalogState(&client.state)
}

func hongguoCatalogInitialized(state *hongguoCatalogState) bool {
	if state != nil && state.Version == 1 {
		for _, cursor := range state.Feeds {
			if cursor.Initialized {
				return true
			}
		}
	}
	return false
}

func hongguoCatalogHasMore(state *hongguoCatalogState) bool {
	for _, genre := range hongguoAppGenres {
		if state == nil || !state.Feeds[genre.key].Exhausted {
			return true
		}
	}
	return false
}

func hongguoAppQuery(deviceID, installID string) url.Values {
	return url.Values{
		"aid": {"8662"}, "app_name": {"novelread"}, "version_code": {"73532"}, "version_name": {"7.3.5.32"},
		"manifest_version_code": {"73532"}, "update_version_code": {"73532"}, "channel": {"update_64"},
		"device_platform": {"android"}, "os": {"android"}, "ssmix": {"a"}, "device_type": {"25053RT47C"},
		"device_brand": {"Redmi"}, "language": {"zh"}, "os_api": {"36"}, "os_version": {"16"},
		"resolution": {"1280*2772"}, "dpi": {"520"}, "ac": {"wifi"}, "device_id": {deviceID}, "iid": {installID},
	}
}

func (downloader *Downloader) hongguoAppRequest(ctx context.Context, method, path string, extra url.Values, payload any) (map[string]any, error) {
	client := downloader.hongguoClient()
	comment, _ := ctx.Value(hongguoCommentKey{}).(bool)
	helper, _ := ctx.Value(hongguoHelperDeviceKey{}).(bool)
	signed := !comment && path != hongguoBookmallTabPath
	var registerErr error
	if signed {
		registerErr = downloader.ensureHongguoDevice(ctx, helper, "")
	}
	client.mu.Lock()
	base := client.baseURL
	deviceID, installID, _ := client.deviceLocked(helper)
	client.mu.Unlock()
	if helper {
		if deviceID == "" || !signed {
			return nil, errors.New("红果辅助设备不可用")
		}
		ctx = context.WithValue(ctx, requestLaneKey{}, "hongguo-helper")
	}
	query := hongguoAppQuery(deviceID, installID)
	for key, values := range extra {
		query[key] = append([]string(nil), values...)
	}
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			return nil, err
		}
	}
	attempts := downloader.cfg.Retries
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 3 {
		attempts = 3
	}
	var lastErr error
	rotations := 0
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		request.Header.Set("User-Agent", hongguoAppUserAgent)
		request.Header.Set("Accept", "application/json")
		request.Header.Set("X-XS-From-Web", "0")
		request.Header.Set("Sdk-Version", "2")
		var commentNonce hongguoCommentNonce
		if comment {
			commentNonce, err = newHongguoCommentNonce()
			if err != nil {
				return nil, errors.New("无法准备红果文字请求")
			}
			request.Header.Set("Comment-Source", "601")
			request.Header.Set("Server-Channel", "1000")
		}
		if payload != nil {
			request.Header.Set("Content-Type", "application/json; charset=utf-8")
		}
		if cookie := downloader.hongguoLoginCookieHeader(); cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token := downloader.hongguoLoginCookie("x-tt-token"); token != "" {
			request.Header.Set("x-tt-token", token)
		}
		if extra, _ := ctx.Value(hongguoExtraHeadersKey{}).(map[string]string); len(extra) > 0 {
			for key, value := range extra {
				request.Header.Set(key, value)
			}
		}
		response, err := downloader.doPreparedCatalogRequest(request, 20*time.Second, func(prepared *http.Request) {
			now := time.Now()
			query.Set("_rticket", strconv.FormatInt(now.UnixMilli(), 10))
			prepared.URL.RawQuery = query.Encode()
			if comment {
				mode, _ := ctx.Value(hongguoSignModeKey{}).(string)
				switch mode {
				case "none":
					// 不带任何 X-* 签名头，观察服务端反应
				case "fake":
					prepared.Header.Set("X-Helios", "ZmFrZS1oZWxpb3M=")
					prepared.Header.Set("X-Medusa", "ZmFrZS1tZWR1c2E=")
				case "pure":
					sig := hongguoPureSign(prepared.URL.String(), body, uint32(now.Unix()))
					for k, v := range sig {
						prepared.Header.Set(k, v)
					}
				case "minimal":
					helios, medusa := hongguoSignMinimal(prepared, now)
					log.Printf("hongguoApp minimal path=%s helios=%s medusa=%q", path, helios, medusa)
					prepared.Header.Set("X-Helios", helios)
					prepared.Header.Set("X-Medusa", medusa)
				default:
					signHongguoCommentRequest(prepared, commentNonce, now)
					if len(body) > 0 {
						sum := md5.Sum(body)
						prepared.Header.Set("X-SS-STUB", strings.ToUpper(hex.EncodeToString(sum[:])))
					}
				}
			} else if signed {
				signHongguoPlayerRequest(prepared, body, now)
			}
		})
		if err != nil {
			lastErr = err
			var backoff *requestBackoff
			if errors.As(err, &backoff) || ctx.Err() != nil {
				return nil, err
			}
			continue
		}
		downloader.captureHongguoLoginCookies(response)
		content, readErr := io.ReadAll(io.LimitReader(response.Body, providerMaxBodyBytes+1))
		response.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if response.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("红果 App 接口 HTTP %d", response.StatusCode)
			if response.StatusCode >= 400 && response.StatusCode < 500 {
				return nil, lastErr
			}
			continue
		}
		if len(content) == 0 {
			if hint := hongguoBdturingHint(response); hint != "" {
				log.Printf("hongguoApp bdturing path=%s %s", path, hint)
				return nil, fmt.Errorf("红果 App 接口需要风控验证（%s）", hint)
			}
			lastErr = errors.New("红果 App 接口未返回有效数据")
			if signed && rotations < hongguoDeviceRotations {
				if registerErr = downloader.ensureHongguoDevice(ctx, helper, deviceID); registerErr == nil {
					rotations++
					deviceID, installID, _ = client.device(helper)
					query.Set("device_id", deviceID)
					query.Set("iid", installID)
					attempt--
				}
			}
			if registerErr != nil {
				lastErr = fmt.Errorf("红果 App 接口未返回有效数据（设备注册失败：%v）", registerErr)
			}
			continue
		}
		if len(content) > providerMaxBodyBytes {
			return nil, errors.New("红果 App 接口未返回有效数据")
		}
		var result map[string]any
		decoder := json.NewDecoder(bytes.NewReader(content))
		decoder.UseNumber()
		if err := decoder.Decode(&result); err != nil || result == nil {
			return nil, errors.New("红果 App 接口返回格式异常")
		}
		code := firstNonEmpty(mapString(result, "code", "Code", "status_code"), mapString(nestedMap(result, "BaseResp"), "StatusCode"))
		if code != "" && code != "0" {
			if hint := hongguoBdturingHint(response); hint != "" {
				log.Printf("hongguoApp bdturing path=%s code=%s %s", path, code, hint)
			}
			log.Printf("hongguoApp raw path=%s code=%s body=%s", path, code, truncate(string(content), 900))
			return nil, fmt.Errorf("红果 App 接口暂不可用（%s）", truncate(code, 20))
		}
		return result, nil
	}
	return nil, lastErr
}

// hongguoBdturingHint 读取响应里的字节跳动 bdturing 风控验证信息。
// 实测：UGC 写接口（如 /reading/ugc/comment/emoticon/collect/v）在命中风控时
// 返回 HTTP 200 + 空 body，并带上 bdturing-verify 头；不带任何 X-* 签名头时
// 同一个请求会得到业务错误码 101003。也就是说这类接口确实走到了 UGC 业务逻辑，
// 但被风控挑战拦住，客户端必须完成验证并携带 token 才能成功。
func hongguoBdturingHint(response *http.Response) string {
	raw := firstNonEmpty(response.Header.Get("bdturing-verify"), response.Header.Get("x-vc-bdturing-parameters"))
	if raw == "" {
		return ""
	}
	var parsed struct {
		Code        string `json:"code"`
		Type        string `json:"type"`
		Subtype     string `json:"subtype"`
		LoginStatus int    `json:"login_status"`
	}
	_ = json.Unmarshal([]byte(raw), &parsed)
	return fmt.Sprintf("log_id=%s type=%s subtype=%s code=%s login_status=%d",
		response.Header.Get("x-tt-logid"), parsed.Type, parsed.Subtype, parsed.Code, parsed.LoginStatus)
}
