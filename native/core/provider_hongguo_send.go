package core

import (
	"context"
	"time"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const hongguoFavoriteUpdatePath = "/reading/bookapi/bookshelf/video/update/v/"

// hgSendDanmaku 发送弹幕（comment_type/data_type = 20）。
func (engine *nativeEngine) hgSendDanmaku(ctx context.Context, seriesID, videoID, text string, offsetMS int64) (map[string]any, error) {
	seriesID = strings.TrimSpace(seriesID)
	videoID = strings.TrimSpace(videoID)
	text = strings.TrimSpace(text)
	if !hongguoNumericID.MatchString(seriesID) || !hongguoNumericID.MatchString(videoID) {
		return nil, errors.New("缺少剧集或视频 id")
	}
	if text == "" {
		return nil, errors.New("弹幕内容不能为空")
	}
	if offsetMS < 0 {
		offsetMS = 0
	}
	body := map[string]any{
		"comment_source": 601, "server_channel": 1000,
		"group_id": videoID, "group_type": 30,
		"comment_type": 20, "data_type": 20, "text": text,
		"business_param": map[string]any{
			"book_id": seriesID, "offset_time": offsetMS,
			"playlet_item_duration": offsetMS + 1000,
			"is_author":             false,
		},
	}
	ctx = context.WithValue(ctx, backgroundCatalogKey{}, true)
	ctx = context.WithValue(ctx, hongguoCommentKey{}, true)
	resp, err := engine.downloader.hongguoAppRequest(ctx, http.MethodPost, "/novel/commentapi/comment/add/v1/", nil, body)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": toInt64(resp["code"]) == 0, "code": toInt64(resp["code"]), "message": strOr(resp, "message")}, nil
}

// hgSendComment 发送评论（comment_type/data_type = 4），挂在剧集或视频下。
func (engine *nativeEngine) hgSendComment(ctx context.Context, seriesID, videoID, text string) (map[string]any, error) {
	seriesID = strings.TrimSpace(seriesID)
	videoID = strings.TrimSpace(videoID)
	text = strings.TrimSpace(text)
	if !hongguoNumericID.MatchString(videoID) {
		return nil, errors.New("缺少视频 id")
	}
	if text == "" {
		return nil, errors.New("评论内容不能为空")
	}
	body := map[string]any{
		"comment_source": 601, "server_channel": 1000,
		"group_id": videoID, "group_type": 30,
		"comment_type": 4, "data_type": 4, "text": text,
		"business_param": map[string]any{"book_id": seriesID, "is_author": false},
	}
	ctx = context.WithValue(ctx, backgroundCatalogKey{}, true)
	ctx = context.WithValue(ctx, hongguoCommentKey{}, true)
	resp, err := engine.downloader.hongguoAppRequest(ctx, http.MethodPost, "/novel/commentapi/comment/add/v1/", nil, body)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": toInt64(resp["code"]) == 0, "code": toInt64(resp["code"]), "message": strOr(resp, "message")}, nil
}

// hgSendReview 发表剧评（group_id = 剧 id，score 0-10）。
func (engine *nativeEngine) hgSendReview(ctx context.Context, seriesID, videoID, text string, score int) (map[string]any, error) {
	seriesID = strings.TrimSpace(seriesID)
	videoID = strings.TrimSpace(videoID)
	text = strings.TrimSpace(text)
	if !hongguoNumericID.MatchString(seriesID) {
		return nil, errors.New("缺少剧集 id")
	}
	if text == "" {
		return nil, errors.New("剧评内容不能为空")
	}
	if score < 0 || score > 10 {
		return nil, errors.New("剧评打分须在 0-10 之间")
	}
	if !hongguoNumericID.MatchString(videoID) {
		videoID = seriesID
	}
	body := map[string]any{
		"comment_source": 601, "server_channel": 1000,
		"group_id": seriesID, "group_type": 30,
		"comment_type": 4, "data_type": 4, "text": text,
		"score": score,
		"business_param": map[string]any{"book_id": seriesID, "is_author": false, "review_score": score},
	}
	ctx = context.WithValue(ctx, backgroundCatalogKey{}, true)
	ctx = context.WithValue(ctx, hongguoCommentKey{}, true)
	resp, err := engine.downloader.hongguoAppRequest(ctx, http.MethodPost, "/novel/commentapi/comment/add/v1/", nil, body)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": toInt64(resp["code"]) == 0, "code": toInt64(resp["code"]), "message": strOr(resp, "message")}, nil
}

// hgDigg 点赞/取消点赞当前剧集（object_id 必须是单集 video id）。
func (engine *nativeEngine) hgDigg(ctx context.Context, videoID string, like bool) (map[string]any, error) {
	videoID = strings.TrimSpace(videoID)
	if !hongguoNumericID.MatchString(videoID) {
		return nil, errors.New("缺少视频 id")
	}
	actionType := 3
	if !like {
		actionType = 4
	}
	body := map[string]any{"action_type": actionType, "object_type": 6, "object_id": videoID}
	resp, err := engine.downloader.hongguoAppRequest(ctx, http.MethodPost, "/novel/articleapi/do_action/v1/", nil, body)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": toInt64(resp["code"]) == 0, "code": toInt64(resp["code"]), "message": strOr(resp, "message")}, nil
}

// hgCommentProbe 调试：任意 path/body，可选 comment 签名与额外 query，用于探测 UGC 写接口。
func (engine *nativeEngine) hgCommentProbe(ctx context.Context, path, queryJSON, bodyJSON string, comment bool, mode string) (map[string]any, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("路径为空")
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
	var payload map[string]any
	if b := strings.TrimSpace(bodyJSON); b != "" {
		if err := json.Unmarshal([]byte(b), &payload); err != nil {
			return nil, fmt.Errorf("body JSON 解析失败: %w", err)
		}
	}
	ctx = context.WithValue(ctx, backgroundCatalogKey{}, true)
	if comment {
		ctx = context.WithValue(ctx, hongguoCommentKey{}, true)
	}
	if mode != "" {
		ctx = context.WithValue(ctx, hongguoSignModeKey{}, mode)
	}
	resp, err := engine.downloader.hongguoAppRequest(ctx, http.MethodPost, path, extra, payload)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// hgSetFavorite 收藏/取消收藏短剧（竞品同款：bookshelf/video/update/v + update_bookshelf_video_list）
func (engine *nativeEngine) hgSetFavorite(ctx context.Context, seriesID string, add bool) (map[string]any, error) {
	id := strings.TrimSpace(strings.TrimPrefix(seriesID, "hongguo:"))
	if id == "" {
		return nil, errors.New("缺少剧 id")
	}
	now := time.Now()
	item := map[string]any{"book_id": id}
	if add {
		item["operate_type"] = 1
		item["content_type"] = 1
		// 带时间戳，否则服务端落库 collect_time=0，App 端按时间排序时排到最后（看起来像没收藏）
		item["collect_time"] = now.UnixMilli()
		item["last_operate_time"] = now.Unix()
		item["modify_time"] = now.UnixMilli()
		item["modify_count"] = 1
	} else {
		item["video_shelf_operate_type"] = 1
	}
	res, err := engine.hongguoLoginRequest(ctx, "POST", hongguoFavoriteUpdatePath, nil, map[string]any{
		"update_bookshelf_video_list": []any{item},
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "fav": add, "raw": res}, nil
}
