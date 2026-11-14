package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"duanjuapp/native/core"
)

func call(v map[string]any) map[string]any {
	b, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal([]byte(core.NativeRequest(string(b))), &out)
	return out
}

func main() {
	fmt.Println("init:", call(map[string]any{"action": "initialize", "directory": "/volume1/AI/红果/client/data"}))
	cat := call(map[string]any{"action": "catalog", "source": "hongguo", "category": "", "page": 1})
	data, _ := cat["data"].(map[string]any)
	items, _ := data["items"].([]any)
	first, _ := items[0].(map[string]any)
	fmt.Println("drama:", first["id"], first["title"])
	detail := call(map[string]any{"action": "detail", "source": "hongguo", "drama": first})
	d, _ := detail["data"].(map[string]any)
	chapters, _ := d["chapters"].([]any)
	chapter, _ := chapters[0].(map[string]any)
	fmt.Println("chapter:", chapter["id"], chapter["videoUrl"])
	plan := call(map[string]any{"action": "resolve", "source": "hongguo", "drama": first, "chapter": chapter, "index": 0, "quality": 0, "sequence": 1})
	fmt.Println("resolve ok:", plan["ok"], "err:", plan["error"])
	p, _ := plan["data"].(map[string]any)
	if p == nil {
		return
	}
	fmt.Printf("plan url=%v quality=%v qualities=%v session=%v key=%v route=%v/%v\n", p["url"], p["quality"], p["qualities"], p["session"], p["decryptionKey"], p["routeIndex"], p["routeCount"])
	u, _ := p["url"].(string)
	client := &http.Client{Timeout: 30 * time.Second}
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("Range", "bytes=0-131071")
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("fetch err:", err)
		return
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	fmt.Printf("fetch: HTTP %d ct=%s len=%d\n", resp.StatusCode, resp.Header.Get("Content-Type"), len(body))
	if len(body) > 0 {
		n := 32
		if len(body) < n {
			n = len(body)
		}
		fmt.Printf("head hex: %x\n", body[:n])
	}
}
