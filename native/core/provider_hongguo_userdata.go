package core

// 红果账号数据（收藏 / 观看历史 / 点赞 / 收藏夹）读取。
//
// 网页端扫码登录成功后，passport 会话 cookie 同时被红果 App 接口接受，
// 因此可以直接调用 App 的 bookshelf / read_history / ugc action 接口读取账号数据。

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"
)

const (
	hongguoFavInfoPath = "/reading/bookapi/bookshelf/video/info/v/"
	hongguoFavListPath = "/reading/bookapi/bookshelf/video/list/v/"
	hongguoHistoryPath = "/reading/bookapi/read_history/list/v/"
	hongguoLikesPath   = "/reading/ugc/action/mget/v/"
	hongguoFolderPath  = "/reading/distribution/bookshelf_folder/list/v1/"
	hongguoSubscribePath = "/reading/user/subscribe/list/v1/"
	hongguoFollowUpdatePath = "/reading/bookapi/bookshelf/video/update/v/"
)

// hongguoVideoKind 把接口的 content_type / video_category_type 归一成前端筛选用分类：
// real=真人剧, comic=漫剧, ai=AI剧。
// hongguoZeroBased 把红果接口里 1 基的 vid_index 转成章节数组下标。
func hongguoZeroBased(idx int64) int64 {
	if idx > 0 {
		return idx - 1
	}
	return 0
}

func hongguoVideoKind(contentType int64, categoryType string) string {
	if strings.EqualFold(strings.TrimSpace(categoryType), "ai_video") {
		return "ai"
	}
	if contentType == 1004 {
		return "comic"
	}
	return "real"
}

func hongguoTextOf(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		parts := make([]string, 0, len(t))
		for _, item := range t {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "")
	}
	return ""
}

func hongguoShortTitle(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	runes := []rune(s)
	if len(runes) > 30 {
		return string(runes[:30])
	}
	return s
}

// hongguoFavMeta 读取收藏列表的精简行（content_type / video_category_type），用于分类。
func hongguoFavMeta(ctx context.Context, downloader *Downloader) map[string]map[string]any {
	out := map[string]map[string]any{}
	extra := url.Values{}
	extra.Set("count", "1000")
	extra.Set("offset", "0")
	resp, err := downloader.hongguoAppRequest(ctx, "GET", hongguoFavListPath, extra, nil)
	if err != nil {
		return out
	}
	data, _ := resp["data"].(map[string]any)
	raw, _ := data["video_shelf_info"].([]any)
	for _, v := range raw {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		if sid := strOr(m, "series_id"); sid != "" {
			out[sid] = m
		}
	}
	return out
}

// hgUserFavorites 读取红果账号的收藏（视频书架）。
// 接口：GET /reading/bookapi/bookshelf/video/info/v/ ?count=&offset=
func (engine *nativeEngine) hgUserFavorites(ctx context.Context, page, count int) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	meta := hongguoFavMeta(ctx, engine.downloader)
	items := make([]map[string]any, 0, 128)
	for p := 0; p < 6; p++ {
		extra := url.Values{}
		extra.Set("count", "50")
		extra.Set("offset", strconv.Itoa(p*50))
		resp, err := engine.downloader.hongguoAppRequest(ctx, "GET", hongguoFavInfoPath, extra, nil)
		if err != nil {
			if p == 0 {
				return nil, err
			}
			break
		}
		data, _ := resp["data"].(map[string]any)
		raw, _ := data["video_shelf_info"].([]any)
		for _, v := range raw {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			vd, _ := m["video_data"].(map[string]any)
			seriesID := strOr(vd, "series_id")
			if seriesID == "" {
				seriesID = strOr(m, "series_id")
			}
			if seriesID == "" {
				continue
			}
			kind := "real"
			if mm, ok := meta[seriesID]; ok {
				kind = hongguoVideoKind(toInt64(mm["content_type"]), strOr(mm, "video_category_type"))
			} else if toInt64(m["content_type"]) == 1004 {
				kind = "comic"
			}
			item := map[string]any{
				"id":    "hongguo:" + seriesID,
				"title": strOr(m, "series_title"),
				"cover": strOr(m, "series_cover_url"),
				"intro": strOr(m, "series_intro"),
				"kind":  kind,
			}
			if cnt := toInt64(vd["episode_cnt"]); cnt > 0 {
				item["episodes"] = cnt
			}
			if idx := toInt64(vd["vid_index"]); idx > 0 {
				item["progressIndex"] = hongguoZeroBased(idx)
			}
			if ts := toInt64(m["last_operate_time"]); ts > 0 {
				item["updatedAt"] = ts
			}
			items = append(items, item)
		}
		if more, _ := data["has_more"].(bool); !more || len(raw) == 0 {
			break
		}
	}
	return map[string]any{"items": items, "hasMore": false, "page": 1, "total": len(items)}, nil
}

// hgUserHistory 读取红果账号的观看历史（短剧）。
// 接口：GET /reading/bookapi/read_history/list/v/ ?book_type=2&page=&count=
// book_type=2 为短剧历史，条目自带剧名/封面/集数/当前集（vid_index，0 基）与 vid，
// 可直接用于继续播放，无需再查详情。
func (engine *nativeEngine) hgUserHistory(ctx context.Context, page, count int) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	items := make([]map[string]any, 0, 256)
	{
		// 该接口忽略 page/count，一次返回全部历史，无需翻页。
		extra := url.Values{}
		extra.Set("book_type", "2")
		extra.Set("page", "1")
		extra.Set("count", "100")
		resp, err := engine.downloader.hongguoAppRequest(ctx, "GET", hongguoHistoryPath, extra, nil)
		if err != nil {
			return nil, err
		}
		data, _ := resp["data"].(map[string]any)
		raw, _ := data["data_list"].([]any)
		for _, v := range raw {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			if del, _ := m["is_delete"].(bool); del {
				continue
			}
			if bt := toInt64(m["book_type"]); bt != 2 {
				continue
			}
			id := strOr(m, "book_id_str")
			if id == "" {
				if bid := toInt64(m["book_id"]); bid > 0 {
					id = strconv.FormatInt(bid, 10)
				}
			}
			if id == "" {
				continue
			}
			item := map[string]any{
				"id":            "hongguo:" + id,
				"title":         strOr(m, "book_name"),
				"cover":         strOr(m, "thumb_url"),
				"episodes":      toInt64(m["episode_cnt"]),
				"progressIndex": hongguoZeroBased(toInt64(m["vid_index"])),
				"updatedAt":     toInt64(m["read_timestamp_ms"]),
				"position":      toInt64(m["current_play_position"]),
				"duration":      toInt64(m["duration"]),
				"vid":           strconv.FormatInt(toInt64(m["vid"]), 10),
			}
			items = append(items, item)
		}
	}
	return map[string]any{"items": items, "hasMore": false, "page": 1, "total": len(items)}, nil
}

// hgUserLikes 读取红果账号点赞过的短剧。
// 接口：GET /reading/ugc/action/mget/v/ ?action_type=3&object_type_list=6,15,10&count=&offset=
func (engine *nativeEngine) hgUserLikes(ctx context.Context, page, count int) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	items := make([]map[string]any, 0, 128)
	for p := 0; p < 5; p++ {
		extra := url.Values{}
		extra.Set("action_type", "3")
		extra.Set("object_type_list", "6,15,10")
		extra.Set("count", "100")
		extra.Set("offset", strconv.Itoa(p*100))
		resp, err := engine.downloader.hongguoAppRequest(ctx, "GET", hongguoLikesPath, extra, nil)
		if err != nil {
			if p == 0 {
				return nil, err
			}
			break
		}
		data, _ := resp["data"].(map[string]any)
		raw, _ := data["mixed_data_list"].([]any)
		for _, v := range raw {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			vd, _ := m["video_data"].(map[string]any)
			if vd == nil {
				continue
			}
			seriesID := strOr(vd, "series_id")
			if seriesID == "" {
				continue
			}
			det, _ := vd["video_detail"].(map[string]any)
			title := ""
			cover := strOr(vd, "cover")
			if det != nil {
				title = strOr(det, "series_title")
				if cover == "" {
					cover = strOr(det, "series_cover")
				}
			}
			if title == "" {
				title = hongguoShortTitle(strOr(vd, "title"))
			}
			contentType := toInt64(vd["content_type"])
			kind := hongguoVideoKind(contentType, strOr(vd, "video_category_type"))
			if contentType == 1004 {
				// 1004 同时包含漫剧与 AI 短剧，用底部文案区分。
				if det != nil {
					bb, _ := det["bottom_bar"].(map[string]any)
					if strings.Contains(hongguoTextOf(bb["text"]), "漫剧") {
						kind = "comic"
					} else {
						kind = "ai"
					}
				}
			}
			idx := toInt64(vd["vid_index"]) // 点赞接口的 vid_index 是 1 基
			if idx > 0 {
				idx--
			}
			item := map[string]any{
				"id":            "hongguo:" + seriesID,
				"title":         title,
				"cover":         cover,
				"episodes":      toInt64(vd["episode_cnt"]),
				"progressIndex": hongguoZeroBased(idx),
				"vid":           strconv.FormatInt(toInt64(vd["vid"]), 10),
				"kind":          kind,
				"diggedCount":   toInt64(vd["digged_count"]),
				"updatedAt":     toInt64(vd["user_digg_timestamp_ms"]),
			}
			items = append(items, item)
		}
		if more, _ := data["has_more"].(bool); !more || len(raw) == 0 {
			break
		}
	}
	return map[string]any{"items": items, "hasMore": false, "page": 1, "total": len(items)}, nil
}

// hgUserFolders 读取红果账号的收藏夹列表。
// 接口：POST /reading/distribution/bookshelf_folder/list/v1/ ?count=-1
func (engine *nativeEngine) hgUserFolders(ctx context.Context) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	extra := url.Values{}
	extra.Set("count", "-1")
	resp, err := engine.downloader.hongguoAppRequest(ctx, "POST", hongguoFolderPath, extra, nil)
	if err != nil {
		return nil, err
	}
	data, _ := resp["data"].(map[string]any)
	raw, _ := data["folders"].([]any)
	folders := make([]map[string]any, 0, len(raw))
	for _, v := range raw {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		folders = append(folders, map[string]any{
			"id":    strOr(m, "folder_id"),
			"name":  strOr(m, "folder_name"),
			"count": toInt64(m["item_count"]),
			"cover": strOr(m, "folder_cover"),
		})
	}
	return map[string]any{
		"folders":  folders,
		"count":    toInt64(data["folder_count"]),
		"maxCap":   toInt64(data["max_cap"]),
		"hasMore":  false,
		"page":     1,
	}, nil
}

// hgUserReservations 读取红果账号的预约列表（预约短剧）。
// 接口：GET /reading/user/subscribe/list/v1/ ?tab_type=13&is_online=&offset=&count=
// is_online=true 返回已上线，false 返回待上线；两组分别翻页后合并，前端按 isOnline 分组。
func (engine *nativeEngine) hgUserReservations(ctx context.Context, page, count int) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	if count <= 0 || count > 50 {
		count = 30
	}
	items := make([]map[string]any, 0, 64)
	online, offline := int64(0), int64(0)
	seen := make(map[string]bool, 64)
	for _, onlineFlag := range []string{"true", "false"} {
		offset := 0
		for p := 0; p < 8; p++ {
			extra := url.Values{}
			extra.Set("tab_type", "13")
			extra.Set("is_online", onlineFlag)
			extra.Set("offset", strconv.Itoa(offset))
			extra.Set("count", strconv.Itoa(count))
			resp, err := engine.downloader.hongguoAppRequest(ctx, "GET", hongguoSubscribePath, extra, nil)
			if err != nil {
				if p == 0 {
					return nil, err
				}
				break
			}
			data, _ := resp["data"].(map[string]any)
			if data == nil {
				break
			}
			if p == 0 {
				if onlineFlag == "true" {
					online = toInt64(data["online_total_count"])
				} else {
					offline = toInt64(data["offline_total_count"])
				}
			}
			raw, _ := data["subscribe_items"].([]any)
			for _, v := range raw {
				m, ok := v.(map[string]any)
				if !ok {
					continue
				}
				seriesID := strOr(m, "item_id")
				if seriesID == "" || seen[seriesID] {
					continue
				}
				seen[seriesID] = true
				isOnline, _ := m["is_online"].(bool)
				// 已上线条目把剧集信息放在 subscribe_data 里，待上线条目在顶层。
				sd, _ := m["subscribe_data"].(map[string]any)
				title := strOr(m, "name")
				cover := strOr(m, "cover")
				intro := strOr(m, "item_desc")
				kind := "real"
				episodes := int64(0)
				vid := int64(0)
				if sd != nil {
					if v := strOr(sd, "series_id"); v != "" {
						seriesID = v
					}
					if v := strOr(sd, "title"); v != "" {
						title = v
					}
					if v := strOr(sd, "cover"); v != "" {
						cover = v
					}
					if v := strOr(sd, "video_desc"); v != "" {
						intro = v
					}
					episodes = toInt64(sd["episode_cnt"])
					vid = toInt64(sd["vid"])
					kind = hongguoVideoKind(toInt64(sd["content_type"]), "")
				}
				items = append(items, map[string]any{
					"id":           "hongguo:" + seriesID,
					"title":        title,
					"cover":        cover,
					"intro":        intro,
					"episodes":     episodes,
					"vid":          strconv.FormatInt(vid, 10),
					"isOnline":     isOnline,
					"subscribed":   m["has_subscribed"] == true,
					"expectTime":   toInt64(m["expected_publish_time"]),
					"expectText":   strOr(m, "expected_rec_text"),
					"updatedAt":    toInt64(m["schedule_publish_time"]),
					"kind":         kind,
					"detailSchema": strOr(m, "detail_schema"),
				})
			}
			more, _ := data["has_more"].(bool)
			offset = int(toInt64(data["next_offset"]))
			if !more || len(raw) == 0 {
				break
			}
		}
	}
	return map[string]any{
		"items":        items,
		"onlineTotal":  online,
		"offlineTotal": offline,
		"hasMore":      false,
		"nextOffset":   0,
		"page":         page,
		"total":        len(items),
	}, nil
}

// hgUserFollowUpdates 读取红果账号的追更列表（追更的剧 / 更新提醒）。
// 接口：POST /reading/bookapi/bookshelf/video/update/v/
// body: {"action_channel":9,"cursor_str":<上页 cursor>,"count":30}
// 接口在无追更数据时返回 data:null，此时按空列表处理。
func (engine *nativeEngine) hgUserFollowUpdates(ctx context.Context, cursor string, count int) (map[string]any, error) {
	if engine == nil || engine.downloader == nil {
		return nil, errors.New("应用核心尚未就绪")
	}
	if count <= 0 || count > 50 {
		count = 30
	}
	payload := map[string]any{
		"action_channel": 9,
		"cursor_str":     cursor,
		"count":          count,
	}
	resp, err := engine.downloader.hongguoAppRequest(ctx, "POST", hongguoFollowUpdatePath, nil, payload)
	if err != nil {
		return nil, err
	}
	data, _ := resp["data"].(map[string]any)
	items := make([]map[string]any, 0, 64)
	nextCursor := ""
	if data != nil {
		for _, key := range []string{"update_bookshelf_video_list", "update_list", "video_list", "items", "list"} {
			raw, _ := data[key].([]any)
			if len(raw) == 0 {
				continue
			}
			for _, v := range raw {
				m, ok := v.(map[string]any)
				if !ok {
					continue
				}
				seriesID := strOr(m, "series_id")
				if seriesID == "" {
					if vd, _ := m["video_data"].(map[string]any); vd != nil {
						seriesID = strOr(vd, "series_id")
					}
				}
				if seriesID == "" {
					continue
				}
				title := strOr(m, "series_title")
				if title == "" {
					title = strOr(m, "title")
				}
				if title == "" {
					if vd, _ := m["video_data"].(map[string]any); vd != nil {
						title = strOr(vd, "series_title")
					}
				}
				cover := strOr(m, "series_cover_url")
				if cover == "" {
					cover = strOr(m, "cover")
				}
				items = append(items, map[string]any{
					"id":            "hongguo:" + seriesID,
					"title":         hongguoShortTitle(title),
					"cover":         cover,
					"episodes":      toInt64(m["episode_cnt"]),
					"progressIndex": hongguoZeroBased(toInt64(m["vid_index"])),
					"updatedAt":     toInt64(m["update_time"]),
					"updateCount":   toInt64(m["update_episode_cnt"]),
					"vid":           strconv.FormatInt(toInt64(m["vid"]), 10),
					"kind":          hongguoVideoKind(toInt64(m["content_type"]), strOr(m, "video_category_type")),
				})
			}
			break
		}
		if c := strOr(data, "cursor_str"); c != "" {
			nextCursor = c
		} else if c := strOr(data, "next_cursor"); c != "" {
			nextCursor = c
		}
	}
	return map[string]any{
		"items":      items,
		"hasMore":    nextCursor != "",
		"nextCursor": nextCursor,
		"total":      len(items),
	}, nil
}
