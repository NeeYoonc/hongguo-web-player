package core

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// 红果 App「新剧」页使用的 cell（来自 nrlynx subscribe-list 模板）。
const (
	hongguoNewSeriesCellID   = "7431550523368554558"
	hongguoNewSeriesSelected = "firstonlinetime_new"
	hongguoCalendarTabType   = "5"
	hongguoCalendarPath      = "/reading/user/subscribe/list/v1/"
)

// hgNewSeries 拉取新剧推荐（cell_gender: 2 全部 / 1 男频 / 0 女频）。
func (downloader *Downloader) hgNewSeries(ctx context.Context, gender, cursor string) (map[string]any, error) {
	if gender != "0" && gender != "1" {
		gender = "2"
	}
	extra := url.Values{
		"cell_id":        {hongguoNewSeriesCellID},
		"offset":         {"0"},
		"limit":          {"18"},
		"cell_gender":    {gender},
		"selected_items": {hongguoNewSeriesSelected},
		"session_id":     {cursor},
	}
	result, err := downloader.hongguoAppRequest(ctx, http.MethodGet, hongguoBookmallCellChangePath, extra, nil)
	if err != nil {
		return nil, err
	}
	data := nestedMap(result, "data")
	view := nestedMap(data, "cell_view")
	rows := anyList(view["video_data"])
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		m, ok := row.(map[string]any)
		if !ok {
			continue
		}
		seriesID := mapString(m, "series_id")
		if seriesID == "" {
			continue
		}
		item := map[string]any{
			"id":       "hongguo:" + seriesID,
			"title":    mapString(m, "title"),
			"cover":    mapString(m, "cover"),
			"episodes": toInt64(m["episode_cnt"]),
			"score":    mapString(m, "score"),
			"intro":    mapString(m, "video_desc"),
			"heat":     toInt64(m["play_cnt"]),
			"kind":     hongguoVideoKind(toInt64(m["content_type"]), ""),
		}
		items = append(items, item)
	}
	hasMore, _ := data["has_more"].(bool)
	cursorNext := mapString(data, "next_offset")
	if cursorNext == "" {
		cursorNext = strconv.FormatInt(toInt64(data["next_offset"]), 10)
	}
	return map[string]any{"items": items, "cursor": cursorNext, "hasMore": hasMore}, ctx.Err()
}

// hgCalendar 拉取上新日历：date 为 YYYYMMDD；返回 dates/today/date/items/cursor/hasMore。
func (downloader *Downloader) hgCalendar(ctx context.Context, date, cursor string) (map[string]any, error) {
	if len(date) != 8 {
		date = ""
	}
	extra := url.Values{
		"tab_type":             {hongguoCalendarTabType},
		"version":              {"0"},
		"need_calendar_schema": {"true"},
		"offset":               {"0"},
		"limit":                {"20"},
		"session_id":           {cursor},
	}
	if date != "" {
		extra.Set("target_date", date)
	}
	result, err := downloader.hongguoAppRequest(ctx, http.MethodGet, hongguoCalendarPath, extra, nil)
	if err != nil {
		return nil, err
	}
	data := nestedMap(result, "data")
	cal := nestedMap(data, "calendar_schema")
	dates := make([]string, 0, 20)
	for _, v := range anyList(cal["date_list"]) {
		if s, ok := v.(string); ok && s != "" {
			dates = append(dates, s)
		}
	}
	rows := anyList(data["subscribe_items"])
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		m, ok := row.(map[string]any)
		if !ok {
			continue
		}
		sd := nestedMap(m, "subscribe_data")
		seriesID := mapString(sd, "series_id")
		if seriesID == "" {
			seriesID = mapString(m, "item_id")
		}
		if seriesID == "" || seriesID == "0" {
			continue
		}
		title := mapString(sd, "title")
		if title == "" {
			title = mapString(m, "name")
		}
		cover := mapString(sd, "cover")
		if cover == "" {
			cover = mapString(m, "cover")
		}
		intro := mapString(sd, "video_desc")
		if intro == "" {
			intro = mapString(m, "item_desc")
		}
		kind := hongguoVideoKind(toInt64(sd["content_type"]), "")
		item := map[string]any{
			"id":       "hongguo:" + seriesID,
			"title":    title,
			"cover":    cover,
			"episodes": toInt64(sd["episode_cnt"]),
			"score":    mapString(sd, "score"),
			"intro":    intro,
			"kind":     kind,
			"online":   toInt64Bool(m["is_online"]),
			"hint":     mapString(m, "expected_rec_text"),
		}
		if !item["online"].(bool) {
			item["publishAt"] = toInt64(m["expected_publish_time"])
		} else {
			item["publishAt"] = toInt64(m["schedule_publish_time"])
		}
		items = append(items, item)
	}
	hasMore, _ := data["has_more"].(bool)
	next := mapString(data, "next_offset")
	if next == "" {
		next = strconv.FormatInt(toInt64(data["next_offset"]), 10)
	}
	return map[string]any{
		"dates":   dates,
		"today":   mapString(cal, "current_date"),
		"date":    mapString(cal, "default_date"),
		"items":   items,
		"cursor":  next,
		"hasMore": hasMore,
	}, ctx.Err()
}

func toInt64Bool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return strings.EqualFold(x, "true") || x == "1"
	}
	return false
}
