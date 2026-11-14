package core

import (
	"context"
	"strings"
	"sync"
)

// hgBatchHeat 并发拉取多部剧详情，只返回热度映射，供列表卡片补全（catalog 数据源部分条目没有 heat）。
func (downloader *Downloader) hgBatchHeat(ctx context.Context, ids []string) (map[string]any, error) {
	seriesIDs := make([]string, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		id = strings.TrimPrefix(id, "hongguo:")
		if id == "" || seen[id] || !hongguoNumericID.MatchString(id) {
			continue
		}
		seen[id] = true
		seriesIDs = append(seriesIDs, id)
		if len(seriesIDs) >= 120 {
			break
		}
	}
	heat := make(map[string]any, len(seriesIDs))
	if len(seriesIDs) == 0 {
		return map[string]any{"heat": heat}, nil
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for _, seriesID := range seriesIDs {
		wg.Add(1)
		go func(seriesID string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			entry, err := downloader.hongguoAppDetail(ctx, seriesID)
			if err != nil || entry.Drama.Heat == "" {
				return
			}
			mu.Lock()
			heat["hongguo:"+seriesID] = entry.Drama.Heat
			mu.Unlock()
		}(seriesID)
	}
	wg.Wait()
	return map[string]any{"heat": heat}, nil
}
