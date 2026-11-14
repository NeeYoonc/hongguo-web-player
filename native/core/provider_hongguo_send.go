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

// hgReportProgress 上报观看进度到红果账号（竞品同款：read_history/update + read_progress/upload）。
// seriesID 为剧 id，vid 为单集视频 id，episode 为 1 基集号。
func (engine *nativeEngine) hgReportProgress(ctx context.Context, seriesID, vid string, episode, positionMS, cumulativeMS int64) (map[string]any, error) {
	sid := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(seriesID), "hongguo:"))
	v := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(vid), "hongguo-cenc://"))
	if sid == "" || v == "" {
		return nil, errors.New("缺少剧/集 id")
	}
	if episode < 1 {
		episode = 1
	}
	wireIndex := episode - 1
	now := time.Now().UnixMilli()
	bookVal := any(sid)
	if n, perr := strconv.ParseUint(sid, 10, 64); perr == nil {
		bookVal = n
	}
	vidVal := any(v)
	if n, perr := strconv.ParseUint(v, 10, 64); perr == nil {
		vidVal = n
	}
	updateItem := map[string]any{
		"book_id": bookVal, "book_type": 2, "chapter_index": 0,
		"current_play_position": positionMS, "digged_count": 0, "duration": 0, "episode_cnt": 0,
		"is_delete": false, "is_interactive_game": false, "is_listen_mode": false,
		"is_multi_season": 0, "meet_guide_comment_tag": false, "origin_novel_book_id": 0,
		"player_accumulate_total_time": cumulativeMS, "read_timestamp_ms": now, "recent_reads": 0,
		"retain_video_play_time": 0, "season_index": 0, "series_play_cnt": 0, "tone_id": 0,
		"update_timestamp_ms": now, "use_soft_delete": false, "user_digg": false,
		"user_playlet_comment_flag": false, "vid": vidVal, "vid_index": wireIndex,
	}
	update, err := engine.hongguoLoginRequest(ctx, "POST", "/reading/bookapi/read_history/update/v", nil, map[string]any{
		"update_datas": []any{updateItem},
	})
	if err != nil {
		return nil, err
	}
	uploadItem := map[string]any{
		"book_id": sid, "book_type": 2, "channel_id": 0, "check_timestamp": false,
		"cur_channel_id": 0, "current_play_time": positionMS, "is_listen_mode": false,
		"is_local_book": false, "item_id": v, "listen_and_read": false, "page_index": 0,
		"page_progress_rate": 0, "paragraph_offset": 0,
		"player_cumulative_total_duration": cumulativeMS, "progress_type": 0,
		"read_timestamp_ms": now, "tone_id": 0, "vid_index": 0,
	}
	upload, uerr := engine.hongguoLoginRequest(ctx, "POST", "/reading/bookapi/read_progress/upload/v", nil, map[string]any{
		"books": []any{uploadItem},
	})
	out := map[string]any{"ok": uerr == nil, "episode": episode, "raw": update}
	if uerr != nil {
		out["uploadError"] = uerr.Error()
	} else {
		out["upload"] = upload
	}
	return out, nil
}
