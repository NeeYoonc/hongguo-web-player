// 本机账号体系：注册/登录/登出 + 每个账号独立的收藏、点赞、历史。
// 说明：红果官方账号登录需要手机号短信验证并走官方 passport 接口（核心未提供），
// 这里先实现本机账号，数据保存在数据目录 users.json，供网页端多账号隔离使用。
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const sessionCookie = "hg_session"
const sessionTTL = 30 * 24 * time.Hour

type userRecord struct {
	Name    string           `json:"name"`
	Salt    string           `json:"salt"`
	Hash    string           `json:"hash"`
	Created int64            `json:"created"`
	Favs    []map[string]any `json:"favs"`
	Likes   []map[string]any `json:"likes"`
	History []map[string]any `json:"history"`
}

type sessionInfo struct {
	Name    string
	Expires time.Time
}

var (
	userMu    sync.Mutex
	users     = map[string]*userRecord{}
	userFile  string
	sessionMu sync.Mutex
	sessions  = map[string]sessionInfo{}
)

func initUsers(dir string) error {
	userFile = filepath.Join(dir, "users.json")
	data, err := os.ReadFile(userFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var payload struct {
		Users map[string]*userRecord `json:"users"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return err
	}
	if payload.Users != nil {
		users = payload.Users
	}
	return nil
}

func saveUsersLocked() {
	userMu.Lock()
	defer userMu.Unlock()
	payload := struct {
		Users map[string]*userRecord `json:"users"`
	}{Users: users}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	tmp := userFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		log.Printf("保存用户数据失败: %v", err)
		return
	}
	if err := os.Rename(tmp, userFile); err != nil {
		log.Printf("保存用户数据失败: %v", err)
	}
}

func hashPassword(salt, password string) string {
	sum := sha256.Sum256([]byte(salt + ":" + password))
	return hex.EncodeToString(sum[:])
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().String()))[:n*2]
	}
	return hex.EncodeToString(buf)
}

func newSession(name string) string {
	token := randomHex(24)
	sessionMu.Lock()
	sessions[token] = sessionInfo{Name: name, Expires: time.Now().Add(sessionTTL)}
	sessionMu.Unlock()
	return token
}

func sessionUser(r *http.Request) string {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie.Value == "" {
		return ""
	}
	sessionMu.Lock()
	defer sessionMu.Unlock()
	info, ok := sessions[cookie.Value]
	if !ok || time.Now().After(info.Expires) {
		delete(sessions, cookie.Value)
		return ""
	}
	return info.Name
}

func setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
}

func readJSONBody(r *http.Request, out any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	return dec.Decode(out)
}

// handleAuth 处理 /auth/register、/auth/login、/auth/logout、/auth/me。
func handleAuth(w http.ResponseWriter, r *http.Request) {
	switch strings.TrimPrefix(r.URL.Path, "/auth/") {
	case "register":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "方法不支持"})
			return
		}
		var req struct {
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if err := readJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求格式错误"})
			return
		}
		name := strings.TrimSpace(req.Name)
		if len([]rune(name)) < 2 || len([]rune(name)) > 20 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "用户名需要 2-20 个字符"})
			return
		}
		if len(req.Password) < 4 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "密码至少 4 位"})
			return
		}
		userMu.Lock()
		if _, exists := users[name]; exists {
			userMu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "用户名已存在"})
			return
		}
		salt := randomHex(8)
		users[name] = &userRecord{Name: name, Salt: salt, Hash: hashPassword(salt, req.Password), Created: time.Now().Unix(), Favs: []map[string]any{}, Likes: []map[string]any{}, History: []map[string]any{}}
		userMu.Unlock()
		saveUsersLocked()
		setSessionCookie(w, newSession(name))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name})
	case "login":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "方法不支持"})
			return
		}
		var req struct {
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if err := readJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求格式错误"})
			return
		}
		name := strings.TrimSpace(req.Name)
		userMu.Lock()
		rec := users[name]
		userMu.Unlock()
		if rec == nil || subtle.ConstantTimeCompare([]byte(hashPassword(rec.Salt, req.Password)), []byte(rec.Hash)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "用户名或密码不正确"})
			return
		}
		setSessionCookie(w, newSession(name))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name})
	case "logout":
		if cookie, err := r.Cookie(sessionCookie); err == nil && cookie.Value != "" {
			sessionMu.Lock()
			delete(sessions, cookie.Value)
			sessionMu.Unlock()
		}
		clearSessionCookie(w)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "me":
		name := sessionUser(r)
		if name == "" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name})
	default:
		http.NotFound(w, r)
	}
}

var errNoSession = errors.New("请先登录")

// handleUserData 处理 /user/favs、/user/likes、/user/history。
func handleUserData(w http.ResponseWriter, r *http.Request) {
	name := sessionUser(r)
	if name == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": errNoSession.Error()})
		return
	}
	kind := strings.TrimPrefix(r.URL.Path, "/user/")
	userMu.Lock()
	rec := users[name]
	userMu.Unlock()
	if rec == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": errNoSession.Error()})
		return
	}

	if r.Method == http.MethodGet {
		userMu.Lock()
		items := listOf(rec, kind)
		userMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "items": items})
		return
	}

	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "方法不支持"})
		return
	}
	var req struct {
		Action string         `json:"action"`
		Drama  map[string]any `json:"drama"`
		Index  int            `json:"index"`
		Time   float64        `json:"time"`
	}
	if err := readJSONBody(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求格式错误"})
		return
	}
	if req.Drama == nil || strings.TrimSpace(stringOf(req.Drama["id"])) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少剧集信息"})
		return
	}
	id := stringOf(req.Drama["id"])

	userMu.Lock()
	switch kind {
	case "favs", "likes":
		field := &rec.Favs
		if kind == "likes" {
			field = &rec.Likes
		}
		switch req.Action {
		case "add":
			if !containsID(*field, id) {
				*field = append([]map[string]any{slimDrama(req.Drama)}, *field...)
				if len(*field) > 200 {
					*field = (*field)[:200]
				}
			}
		case "remove":
			*field = removeID(*field, id)
		default:
			userMu.Unlock()
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "未知操作"})
			return
		}
	case "history":
		if req.Action == "set" || req.Action == "add" {
			rec.History = removeID(rec.History, id)
			entry := slimDrama(req.Drama)
			entry["index"] = req.Index
			entry["time"] = req.Time
			entry["ts"] = time.Now().Unix()
			rec.History = append([]map[string]any{entry}, rec.History...)
			if len(rec.History) > 200 {
				rec.History = rec.History[:200]
			}
		} else {
			userMu.Unlock()
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "未知操作"})
			return
		}
	default:
		userMu.Unlock()
		http.NotFound(w, r)
		return
	}
	items := listOf(rec, kind)
	userMu.Unlock()
	saveUsersLocked()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "items": items})
}

func listOf(rec *userRecord, kind string) []map[string]any {
	switch kind {
	case "favs":
		return rec.Favs
	case "likes":
		return rec.Likes
	case "history":
		return rec.History
	}
	return nil
}

func slimDrama(drama map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"id", "source", "title", "description", "cover", "episodes", "category", "tags", "heat", "views", "score", "releaseStatus"} {
		if value, ok := drama[key]; ok {
			out[key] = value
		}
	}
	return out
}

func stringOf(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func containsID(items []map[string]any, id string) bool {
	for _, item := range items {
		if stringOf(item["id"]) == id {
			return true
		}
	}
	return false
}

func removeID(items []map[string]any, id string) []map[string]any {
	out := items[:0]
	for _, item := range items {
		if stringOf(item["id"]) != id {
			out = append(out, item)
		}
	}
	return out
}
