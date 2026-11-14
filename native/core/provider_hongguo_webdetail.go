package core

import (
	"context"
	"net/url"
	"strings"
	"time"
)

// mergeHongguoWebCelebrities 用红果网页端详情页的演职员数据补全 App 接口返回的 celebrities。
// App 接口的头像多为 HEIC 签名地址（浏览器无法直接显示），网页端返回的是 JPEG 签名地址。
func (downloader *Downloader) mergeHongguoWebCelebrities(ctx context.Context, drama *Drama) {
	if drama == nil || !hongguoNumericID.MatchString(drama.SourceID) {
		return
	}
	need := drama.RecordNumber == ""
	for _, c := range drama.Celebrities {
		if strings.Contains(strings.ToLower(c.Avatar), ".heic") || c.Avatar == "" {
			need = true
			break
		}
	}
	if !need {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	body, err := downloader.fetchProviderText(cctx, hongguoBaseURL+"/detail?series_id="+url.QueryEscape(drama.SourceID), hongguoBaseURL+"/")
	if err != nil {
		return
	}
	page := routerLoaderMap(parseRouterData(body), "detail_page", "detail_")
	detail, _ := page["seriesDetail"].(map[string]any)
	if len(detail) == 0 {
		return
	}
	if drama.RecordNumber == "" {
		drama.RecordNumber = mapString(detail, "record_number")
	}
	web := hongguoCelebritiesFrom(map[string]any{"celebrities": detail["celebrities"]})
	if len(web) == 0 {
		return
	}
	if len(drama.Celebrities) == 0 {
		drama.Celebrities = web
		return
	}
	byName := make(map[string]Celebrity, len(web))
	for _, c := range web {
		byName[c.Nickname] = c
	}
	for i := range drama.Celebrities {
		if c, ok := byName[drama.Celebrities[i].Nickname]; ok {
			if c.Avatar != "" {
				drama.Celebrities[i].Avatar = c.Avatar
			}
			if drama.Celebrities[i].SubTitle == "" {
				drama.Celebrities[i].SubTitle = c.SubTitle
			}
		}
	}
}
