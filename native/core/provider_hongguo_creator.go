package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// hongguoCreatorWorks 拉取创作者主页「剧作」列表。
// 红果 App 的真实接口：GET /novel/commentapi/user/profile/<uid>/v1/?tab_type=8&cursor=...
func (downloader *Downloader) hongguoCreatorWorks(ctx context.Context, uid, cursor string) (map[string]any, error) {
	uid = strings.TrimSpace(uid)
	if uid == "" {
		return nil, fmt.Errorf("创作者 uid 为空")
	}
	extra := url.Values{}
	extra.Set("tab_type", "8")
	if cursor != "" {
		extra.Set("cursor", cursor)
	}
	path := "/novel/commentapi/user/profile/" + url.PathEscape(uid) + "/v1/"
	raw, err := downloader.hongguoAppRequest(ctx, http.MethodGet, path, extra, nil)
	if err != nil {
		return nil, err
	}
	data := mapOf(raw["data"])
	items := make([]map[string]any, 0, 24)
	for _, entry := range sliceOf(data["data_list"]) {
		video := mapOf(mapOf(entry)["video"])
		if len(video) == 0 {
			continue
		}
		common := mapOf(video["common"])
		expand := mapOf(video["expand"])
		stat := mapOf(video["stat"])
		videoID := mapString(video, "video_id")
		if videoID == "" {
			continue
		}
		item := map[string]any{
			"id":          "hongguo:" + videoID,
			"source":      "hongguo",
			"title":       mapString(common, "title"),
			"cover":       mapString(common, "cover"),
			"intro":       mapString(common, "intro"),
			"episodes":    toInt64(expand["episode_cnt"]),
			"heat":        mapString(stat, "play_cnt"),
			"followCount": mapString(stat, "followed_cnt"),
		}
		tags := make([]string, 0, 6)
		for _, tag := range sliceOf(expand["sub_title_list"]) {
			if text := mapString(mapOf(tag), "text"); text != "" && len(tags) < 8 {
				tags = append(tags, text)
			}
		}
		if len(tags) > 0 {
			item["tags"] = tags
		}
		items = append(items, item)
	}
	next := ""
	hasMore := false
	if info := mapOf(data["common_list_info"]); len(info) > 0 {
		if rawCursor := mapString(info, "cursor"); rawCursor != "" {
			var parsed map[string]any
			if json.Unmarshal([]byte(rawCursor), &parsed) == nil {
				next = mapString(parsed, "next_cursor")
				hasMore = toInt64Bool(parsed["has_more"])
			}
		}
	}
	total := int64(0)
	if highlight := mapOf(data["hightlight"]); len(highlight) > 0 {
		total = toInt64(highlight["total"])
	}
	return map[string]any{
		"uid":     uid,
		"items":   items,
		"cursor":  next,
		"hasMore": hasMore,
		"total":   total,
	}, nil
}

func mapOf(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func sliceOf(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// hongguoPlainGet 使用当前登录 cookie 发起未签名请求（部分接口只认 cookie，不认 App 签名）。
func (downloader *Downloader) hongguoPlainGet(ctx context.Context, path string, query url.Values) (map[string]any, error) {
	client := downloader.hongguoClient()
	client.mu.Lock()
	base := client.baseURL
	client.mu.Unlock()
	if strings.TrimSpace(base) == "" {
		return nil, errors.New("红果接口地址为空")
	}
	target := strings.TrimRight(base, "/") + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", hongguoAppUserAgent)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Referer", "https://hongguoduanju.com/")
	if cookie := downloader.hongguoLoginCookieHeader(); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	plain := &http.Client{Timeout: 20 * time.Second}
	resp, err := plain.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("解析红果资料失败: %w", err)
	}
	return out, nil
}

// hongguoUserProfile 获取创作者主页资料（粉丝/获赞/红果号/认证/简介等）。
func (engine *nativeEngine) hongguoUserProfile(ctx context.Context, uid string) (map[string]any, error) {
	uid = strings.TrimSpace(uid)
	if uid == "" {
		return nil, errors.New("缺少创作者 id")
	}
	q := url.Values{}
	q.Set("aid", "8662")
	q.Set("user_id", uid)
	resp, err := engine.downloader.hongguoPlainGet(ctx, "/reading/user/profile/get/v/", q)
	if err != nil {
		return nil, err
	}
	if toInt64(resp["code"]) != 0 {
		return map[string]any{"errorCode": toInt64(resp["code"]), "description": strOr(resp, "message")}, nil
	}
	data, _ := resp["data"].(map[string]any)
	user, _ := data["ugc_user"].(map[string]any)
	if user == nil {
		return map[string]any{"found": false}, nil
	}
	base, _ := user["base_info"].(map[string]any)
	relation, _ := user["user_relation"].(map[string]any)
	tag, _ := user["user_tag"].(map[string]any)
	name := strOr(base, "user_name")
	avatar := strOr(base, "user_avatar")
	bio := strOr(base, "description")
	hongguoID := strOr(base, "biz_user_id")
	role := ""
	if list, ok := tag["sub_title_list"].([]any); ok && len(list) > 0 {
		if first, ok := list[0].(map[string]any); ok {
			role = strOr(first, "text")
		}
	}
	verified := false
	if list, ok := tag["user_title_info"].([]any); ok {
		for _, item := range list {
			if m, ok := item.(map[string]any); ok {
				if strOr(m, "en_title") == "actor_has_registered_8662" || strOr(m, "zh_title") != "" {
					verified = true
				}
			}
		}
	}
	return map[string]any{
		"found":       true,
		"uid":         uid,
		"name":        name,
		"avatar":      avatar,
		"bio":         bio,
		"role":        role,
		"hongguoId":   hongguoID,
		"verified":    verified,
		"canFollow":   relation["can_follow"],
		"fansCount":   toInt64(relation["fans_num"]),
		"followCount": toInt64(relation["follow_user_num"]),
		"likedCount":  toInt64(relation["recv_digged_count"]),
	}, nil
}

// hongguoPlainDo 用未签名 + cookie 的方式发起请求（红果部分接口只认 cookie）。
func (downloader *Downloader) hongguoPlainDo(ctx context.Context, method, path string, query url.Values, body any) (map[string]any, error) {
	client := downloader.hongguoClient()
	client.mu.Lock()
	base := client.baseURL
	client.mu.Unlock()
	if strings.TrimSpace(base) == "" {
		return nil, errors.New("红果接口地址为空")
	}
	target := strings.TrimRight(base, "/") + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", hongguoAppUserAgent)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Referer", "https://hongguoduanju.com/")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie := downloader.hongguoLoginCookieHeader(); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	plain := &http.Client{Timeout: 20 * time.Second}
	resp, err := plain.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{"status": resp.StatusCode, "raw": string(raw[:minInt(len(raw), 400)])}, nil
	}
	return out, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// hongguoPlainProbe 调试：用 plain+cookie 请求任意红果接口。
func (engine *nativeEngine) hongguoPlainProbe(ctx context.Context, method, path, query, body string) (map[string]any, error) {
	q := url.Values{}
	if strings.TrimSpace(query) != "" {
		var qm map[string]any
		if err := json.Unmarshal([]byte(query), &qm); err != nil {
			return nil, fmt.Errorf("query 不是合法 JSON: %w", err)
		}
		for k, v := range qm {
			q.Set(k, fmt.Sprint(v))
		}
	}
	var payload any
	if strings.TrimSpace(body) != "" {
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			return nil, fmt.Errorf("body 不是合法 JSON: %w", err)
		}
	}
	return engine.downloader.hongguoPlainDo(ctx, method, path, q, payload)
}
