package core

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// hgCENCKeyID 从加密 mp4 的 tenc box 中读取默认 KID，供浏览器 ClearKey 直连解密使用。
func (engine *nativeEngine) hgCENCKeyID(ctx context.Context, url, referer string) (map[string]any, error) {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return nil, errors.New("播放地址无效")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", "bytes=0-65535")
	req.Header.Set("User-Agent", userAgent)
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 128<<10))
	if err != nil {
		return nil, err
	}
	idx := bytes.Index(body, []byte("tenc"))
	if idx < 0 || idx+28 > len(body) {
		return map[string]any{"keyId": ""}, nil
	}
	return map[string]any{"keyId": strings.ToUpper(hex.EncodeToString(body[idx+12 : idx+28]))}, nil
}
