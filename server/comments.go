package main

import (
	"encoding/json"
	"log"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type webComment struct {
	User   string `json:"user"`
	Avatar string `json:"avatar"`
	Text   string `json:"text"`
	Time   int64  `json:"time"`
	Digg   int64  `json:"digg"`
}

type webComments struct {
	Total int          `json:"total"`
	Items []webComment `json:"items"`
}

// extractJSONObject returns the first balanced {...} starting at or after idx.
func extractJSONObject(s string, idx int) (string, bool) {
	k := strings.IndexByte(s[idx:], '{')
	if k < 0 {
		return "", false
	}
	k += idx
	depth := 0
	inStr := false
	esc := false
	for p := k; p < len(s); p++ {
		c := s[p]
		if inStr {
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[k : p+1], true
			}
		}
	}
	return "", false
}

func fetchWebComments(sid, vid string) (*webComments, error) {
	url := "https://hongguoduanju.com/player/" + sid + "/" + vid
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36")
	req.Header.Set("Referer", "https://hongguoduanju.com/")
	cli := &http.Client{Timeout: 20 * time.Second}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	html := string(body)
	idx := strings.Index(html, `"episodeSocialInfo"`)
	if idx < 0 {
		return nil, fmt.Errorf("comments not found in page")
	}
	ridx := strings.Index(html[idx:], `"reviews"`)
	if ridx < 0 {
		return nil, fmt.Errorf("reviews not found")
	}
	raw, ok := extractJSONObject(html, idx+ridx)
	if !ok {
		return nil, fmt.Errorf("reviews json parse failed")
	}
	var obj struct {
		Total   json.RawMessage `json:"total_count"`
		Reviews []struct {
			CreateTime json.RawMessage `json:"create_time"`
			DiggCount  json.RawMessage `json:"digg_count"`
			UserName   string          `json:"user_name"`
			UserAvatar string          `json:"user_avatar"`
			Content    string          `json:"content"`
		} `json:"reviews"`
	}
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return nil, err
	}
	out := &webComments{Total: int(parseFlexInt(obj.Total))}
	for _, r := range obj.Reviews {
		out.Items = append(out.Items, webComment{
			User: r.UserName, Avatar: strings.ReplaceAll(r.UserAvatar, `\u002F`, "/"),
			Text: r.Content, Time: parseFlexInt(r.CreateTime), Digg: parseFlexInt(r.DiggCount),
		})
	}
	return out, nil
}

func parseFlexInt(raw json.RawMessage) int64 {
	s := strings.Trim(string(raw), `"`)
	if s == "" || s == "null" {
		return 0
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	f, _ := strconv.ParseFloat(s, 64)
	return int64(f)
}

func handleComments(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("sid")
	vid := r.URL.Query().Get("vid")
	if sid == "" || vid == "" {
		writeJSONC(w, 400, map[string]any{"error": "sid/vid required"})
		return
	}
	c, err := fetchWebComments(sid, vid)
	if err != nil {
		// 网页评论通道 2026-11 起也被收紧：改走官方 App 评论接口（侧车）
		if appComments, aerr := fetchAppComments(r.Context(), sid, vid); aerr == nil {
			c = appComments
		} else {
			log.Printf("comments 失败 web=%v app=%v", err, aerr)
			writeJSONC(w, 502, map[string]any{"error": err.Error()})
			return
		}
	}
	writeJSONC(w, 200, c)
}

func writeJSONC(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
