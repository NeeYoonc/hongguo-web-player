// 播放适配层：红果 App 流是 HEVC + CENC 加密，浏览器不能直接播。
// 这里提供三个端点：
//   /probe  取时长/分辨率（ffprobe + decryption_key）
//   /dec    解密 remux 成普通 HEVC MP4（带缓存，支持 Range）——给 Safari 等支持 HEVC 的浏览器
//   /tc     实时转码 H.264 fMP4 流（pipe 给前端 MSE）——给 Chrome/Firefox
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	cacheDir   string
	ffmpegBin  = "ffmpeg"
	ffprobeBin = "ffprobe"

	probeMu    sync.Mutex
	probeCache = map[string]*probeInfo{}

	decMu   sync.Mutex
	decJobs = map[string]*decJob{}
	decSem  = make(chan struct{}, 1) // 同一时间只做一个 remux，避免抢 CPU
)

type probeInfo struct {
	Duration float64 `json:"duration"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Video    string  `json:"video"`
	Audio    string  `json:"audio"`
	Error    string  `json:"error,omitempty"`
}

type decJob struct {
	ready chan struct{}
	path  string
	err   error
}

// streamParams 从查询参数里取 core 本地流服务的端口/路径/解密密钥。
// decryptArgs 返回解密参数；非 CENC 流（key 为空）不传 -decryption_key。
func decryptArgs(key string) []string {
	if key == "" {
		return nil
	}
	return []string{"-decryption_key", key}
}

func streamParams(r *http.Request) (port int, assetPath, key, cacheID string, err error) {
	query := r.URL.Query()
	port, err = strconv.Atoi(query.Get("port"))
	if err != nil || port <= 0 || port > 65535 {
		return 0, "", "", "", fmt.Errorf("端口无效")
	}
	assetPath = query.Get("path")
	if !strings.HasPrefix(assetPath, "/") || strings.Contains(assetPath, "..") ||
		strings.ContainsAny(assetPath, "\x00\r\n") {
		return 0, "", "", "", fmt.Errorf("路径无效")
	}
	key = strings.ToLower(query.Get("key"))
	if key != "" {
		if len(key) != 32 {
			return 0, "", "", "", fmt.Errorf("密钥无效")
		}
		if _, err := hex.DecodeString(key); err != nil {
			return 0, "", "", "", fmt.Errorf("密钥无效")
		}
	}
	// cacheID 是稳定的剧集标识（剧集 id+清晰度），用于缓存命名，避免会话 token 变化导致重复缓存。
	cacheID = strings.TrimSpace(query.Get("id"))
	if len(cacheID) > 200 || strings.ContainsAny(cacheID, "/\\\x00\r\n") {
		cacheID = ""
	}
	return port, assetPath, key, cacheID, nil
}

func localStreamURL(port int, assetPath string) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", port, assetPath)
}

func cacheKeyOf(port int, assetPath, key, cacheID string) string {
	seed := fmt.Sprintf("%d|%s|%s", port, assetPath, key)
	if cacheID != "" {
		seed = cacheID
	}
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:16])
}

// handleProbe 返回时长和分辨率，供前端设置 MSE 时间轴。
func handleProbe(w http.ResponseWriter, r *http.Request) {
	port, assetPath, key, cacheID, err := streamParams(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	cacheKey := cacheKeyOf(port, assetPath, key, cacheID)
	probeMu.Lock()
	info := probeCache[cacheKey]
	probeMu.Unlock()
	if info == nil {
		info = runProbe(localStreamURL(port, assetPath), key)
		if info.Error == "" {
			probeMu.Lock()
			probeCache[cacheKey] = info
			probeMu.Unlock()
		}
	}
	if info.Error != "" {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": info.Error})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "duration": info.Duration, "width": info.Width, "height": info.Height, "video": info.Video, "audio": info.Audio})
}

func runProbe(url, key string) *probeInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	args := []string{"-v", "error"}
	args = append(args, decryptArgs(key)...)
	args = append(args,
		"-show_entries", "format=duration",
		"-show_entries", "stream=codec_type,codec_name,width,height",
		"-of", "json",
		url,
	)
	cmd := exec.CommandContext(ctx, ffprobeBin, args...)
	output, err := cmd.Output()
	if err != nil {
		detail := ""
		if exitErr, ok := err.(*exec.ExitError); ok {
			detail = strings.TrimSpace(string(exitErr.Stderr))
		}
		return &probeInfo{Error: fmt.Sprintf("探测失败: %v %s", err, detail)}
	}
	var parsed struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &parsed); err != nil {
		return &probeInfo{Error: "探测结果解析失败"}
	}
	info := &probeInfo{}
	info.Duration, _ = strconv.ParseFloat(parsed.Format.Duration, 64)
	for _, stream := range parsed.Streams {
		switch stream.CodecType {
		case "video":
			info.Video = stream.CodecName
			info.Width, info.Height = stream.Width, stream.Height
		case "audio":
			info.Audio = stream.CodecName
		}
	}
	if info.Duration <= 0 {
		return &probeInfo{Error: "没有取到视频时长"}
	}
	return info
}

// handleDec 解密 remux 成普通 MP4 并缓存，之后用 http.ServeFile 提供 Range 拖动。
func handleDec(w http.ResponseWriter, r *http.Request) {
	port, assetPath, key, cacheID, err := streamParams(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	target := filepath.Join(cacheDir, "dec", cacheKeyOf(port, assetPath, key, cacheID)+".mp4")
	if info, err := os.Stat(target); err == nil && info.Size() > 0 {
		http.ServeFile(w, r, target)
		return
	}
	decMu.Lock()
	job, exists := decJobs[target]
	if !exists {
		job = &decJob{ready: make(chan struct{})}
		decJobs[target] = job
		go func() {
			job.path, job.err = buildDecFile(localStreamURL(port, assetPath), key, target)
			close(job.ready)
		}()
	}
	decMu.Unlock()

	select {
	case <-job.ready:
	case <-r.Context().Done():
		return
	}
	if job.err != nil {
		log.Printf("解密失败: %v", job.err)
		http.Error(w, "解密失败: "+job.err.Error(), http.StatusBadGateway)
		return
	}
	http.ServeFile(w, r, job.path)
}

func buildDecFile(url, key, target string) (string, error) {
	decSem <- struct{}{}
	defer func() { <-decSem }()
	if info, err := os.Stat(target); err == nil && info.Size() > 0 {
		return target, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	tmp := target + ".part"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	args = append(args, decryptArgs(key)...)
	args = append(args,
		"-i", url,
		"-c", "copy",
		"-tag:v", "hvc1",
		"-movflags", "+faststart",
		"-f", "mp4",
		"-y", tmp,
	)
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("%v %s", err, strings.TrimSpace(string(output)))
	}
	if err := os.Rename(tmp, target); err != nil {
		os.Remove(tmp)
		return "", err
	}
	pruneCache(filepath.Dir(target), 4<<30)
	return target, nil
}

// pruneCache 在缓存超过上限时按修改时间删旧文件。
func pruneCache(dir string, limit int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	items := make([]item, 0, len(entries))
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".mp4") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, item{filepath.Join(dir, entry.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	if total <= limit {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if total <= limit {
			break
		}
		if os.Remove(it.path) == nil {
			total -= it.size
		}
	}
}

// handleTranscode 把加密 HEVC 实时转成 H.264 fMP4 流，供前端 MSE 播放。
// start 为起点秒数（拖动/续播），h 为输出高度上限。
func handleTranscode(w http.ResponseWriter, r *http.Request) {
	port, assetPath, key, _, err := streamParams(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64)
	if start < 0 {
		start = 0
	}
	height, _ := strconv.Atoi(r.URL.Query().Get("h"))
	switch height {
	case 360, 480, 540, 720:
	default:
		height = 720
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	args = append(args, decryptArgs(key)...)
	if start > 0 {
		args = append(args, "-ss", strconv.FormatFloat(start, 'f', 3, 64))
	}
	args = append(args,
		"-i", localStreamURL(port, assetPath),
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-profile:v", "baseline",
		"-level", "3.1",
		"-pix_fmt", "yuv420p",
		"-vf", fmt.Sprintf("scale=-2:%d", height),
		"-c:a", "copy",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	)
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "转码启动失败", http.StatusInternalServerError)
		return
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{target: &stderr, limit: 8 << 10}
	if err := cmd.Start(); err != nil {
		http.Error(w, "转码启动失败", http.StatusInternalServerError)
		return
	}
	log.Printf("转码开始: start=%.1fs h=%d", start, height)

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 64<<10)
	for {
		n, readErr := stdout.Read(buffer)
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				cancel()
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			break
		}
	}
	waitErr := cmd.Wait()
	if waitErr != nil && ctx.Err() == nil {
		log.Printf("转码异常: %v (%s)", waitErr, strings.TrimSpace(stderr.String()))
	}
}

type limitedWriter struct {
	target io.Writer
	limit  int
	written int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	total := len(p)
	if w.written >= w.limit {
		return total, nil
	}
	remain := w.limit - w.written
	chunk := p
	if len(chunk) > remain {
		chunk = chunk[:remain]
	}
	n, err := w.target.Write(chunk)
	w.written += n
	return total, err
}
