package main

import (
	"crypto/sha1"
	_ "embed"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// The HTTP layer: json-server's lib/app.js plus the tinyhttp behavior it relies on (CORS
// middleware, body parser, routing, 404 and error handlers).

const payloadLimit = 102400 // milliparsec's default

var reserved = map[string]bool{"_sort": true, "_page": true, "_per_page": true, "_embed": true, "_where": true}

var (
	oneSegment  = regexp.MustCompile(`^/([^/]+?)/?$`)
	twoSegments = regexp.MustCompile(`^/([^/]+?)/([^/]+?)/?$`)
	anySegments = regexp.MustCompile(`^/([^/]+?)(?:/|$)`)
)

type server struct{ db *DB }

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, PATCH, POST, DELETE")
	if req := r.Header.Get("Access-Control-Request-Headers"); req != "" || len(r.Header.Values("Access-Control-Request-Headers")) > 0 {
		var allowed []string
		for _, name := range strings.Split(req, ",") {
			allowed = append(allowed, jsTrim(name))
		}
		h["Access-Control-Allow-Headers"] = allowed
	} else {
		h.Set("Access-Control-Allow-Headers", "content-type")
	}
	if r.Method == http.MethodOptions {
		// json-server sends "Content-Length: 0" with its 204. net/http deletes the canonical
		// Content-Length key on 204s (RFC 9110 forbids it), so set it under a raw lowercase key,
		// which is written as-is, to answer exactly like the original.
		h["content-length"] = []string{"0"}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	path, fullQuery, listQuery := splitURL(r)

	// The JSON body parser runs before routing, for every path.
	var body any = undefined
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		raw, err := io.ReadAll(io.LimitReader(r.Body, payloadLimit+1))
		if err != nil {
			return
		}
		if len(raw) > payloadLimit {
			sendError(w, r, 500, "Payload too large. Limit: 102400 bytes")
			return
		}
		if len(raw) == 0 {
			body = newObject(0)
		} else if body, err = parseJSON(toValidUTF8(raw)); err != nil {
			log.Printf("SyntaxError: %v", err)
			sendError(w, r, 500, escapeHTML(err.Error()))
			return
		}
	}

	get := r.Method == http.MethodGet || r.Method == http.MethodHead
	params := func(re *regexp.Regexp) ([]string, bool) {
		m := re.FindStringSubmatch(path)
		if m == nil {
			return nil, false
		}
		out := make([]string, len(m)-1)
		for i, raw := range m[1:] {
			v, err := decodeURIComponent(raw)
			if err != nil {
				sendText(w, r, 400, "Bad Request")
				return nil, true
			}
			out[i] = v
		}
		return out, true
	}

	switch {
	case get && (path == "/" || path == ""):
		s.index(w, r)
		return
	case get:
		if p, ok := params(oneSegment); ok {
			if p != nil {
				s.list(w, r, p[0], fullQuery, listQuery)
			}
			return
		}
		if p, ok := params(twoSegments); ok {
			if p != nil {
				s.withRead(w, r, func() (any, error) {
					return s.db.findByID(p[0], p[1], queryAll(parseQuery(fullQuery), "_embed"))
				})
			}
			return
		}
	case r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch:
		if p, ok := params(oneSegment); ok {
			if p != nil {
				s.withBody(w, r, body, func(item *Object) (any, error) {
					switch r.Method {
					case http.MethodPost:
						return s.db.create(p[0], item)
					case http.MethodPut:
						return s.db.updateOrPatch(p[0], item, false)
					}
					return s.db.updateOrPatch(p[0], item, true)
				})
			}
			return
		}
		if r.Method != http.MethodPost {
			if p, ok := params(twoSegments); ok {
				if p != nil {
					s.withBody(w, r, body, func(item *Object) (any, error) {
						return s.db.updateOrPatchByID(p[0], p[1], item, r.Method == http.MethodPatch)
					})
				}
				return
			}
		}
	case r.Method == http.MethodDelete:
		if p, ok := params(twoSegments); ok {
			if p != nil {
				dependents := queryAll(parseQuery(fullQuery), "_dependent")
				s.withWrite(w, r, func() (any, error) { return s.db.destroyByID(p[0], p[1], dependents) })
			}
			return
		}
	}
	// app.use('/:name', …) answers everything else under a resource name with a JSON 404;
	// paths without one fall through to tinyhttp's plain-text 404.
	if p, ok := params(anySegments); ok {
		if p != nil {
			sendJSON(w, r, 404, notFound())
		}
		return
	}
	sendText404(w, r)
}

func notFound() *Object {
	o := newObject(1)
	o.Set("error", "Not Found")
	return o
}

// splitURL returns the raw path, the query as node:querystring sees it (everything after the
// first ?) and as json-server's list handler sees it (req.url.split('?')[1]).
func splitURL(r *http.Request) (path, full, list string) {
	uri := r.RequestURI
	if !strings.HasPrefix(uri, "/") {
		uri = r.URL.RequestURI()
	}
	path, full, _ = strings.Cut(uri, "?")
	list, _, _ = strings.Cut(full, "?")
	return path, full, list
}

func (s *server) list(w http.ResponseWriter, r *http.Request, name, fullQuery, listQuery string) {
	params := parseQuery(listQuery)
	var filters []param
	for _, p := range params {
		if !reserved[p.key] {
			filters = append(filters, p)
		}
	}
	whereObj, err := parseWhere(filters)
	if err != nil {
		sendError(w, r, 500, escapeHTML(err.Error()))
		return
	}
	opts := findOptions{where: whereObj, embed: queryAll(parseQuery(fullQuery), "_embed")}
	if raw, ok := queryGet(params, "_where"); ok {
		if parsed, err := parseJSON(raw); err == nil && parsed != nil && !isPrimitive(parsed) {
			opts.where = parsed
		}
	}
	if raw, ok := queryGet(params, "_page"); ok {
		if n, ok := parseInt10(raw); ok {
			opts.page = &n
		}
	}
	if raw, ok := queryGet(params, "_per_page"); ok {
		if n, ok := parseInt10(raw); ok {
			opts.perPage = &n
		}
	}
	opts.sort, _ = queryGet(params, "_sort")
	s.withRead(w, r, func() (any, error) { return s.db.find(name, opts) })
}

// withRead runs a lookup and serializes its result under the read lock.
func (s *server) withRead(w http.ResponseWriter, r *http.Request, find func() (any, error)) {
	s.db.mu.RLock()
	data, err := find()
	status, out := responseFor(r, data, err)
	s.db.mu.RUnlock()
	out(w, status)
}

func (s *server) withWrite(w http.ResponseWriter, r *http.Request, change func() (any, error)) {
	s.db.mu.Lock()
	data, err := change()
	status, out := responseFor(r, data, err)
	s.db.mu.Unlock()
	out(w, status)
}

func (s *server) withBody(w http.ResponseWriter, r *http.Request, body any, change func(*Object) (any, error)) {
	item, ok := body.(*Object)
	if !ok {
		o := newObject(1)
		o.Set("error", "Body must be a JSON object")
		sendJSON(w, r, 400, o)
		return
	}
	s.withWrite(w, r, func() (any, error) { return change(item) })
}

// responseFor renders the result while the lock is still held (items may change afterwards) and
// returns a function that sends it.
func responseFor(r *http.Request, data any, err error) (int, func(http.ResponseWriter, int)) {
	if err != nil {
		log.Printf("%v", err)
		msg := escapeHTML(err.Error())
		return 500, func(w http.ResponseWriter, status int) { sendError(w, r, status, msg) }
	}
	if data == undefined {
		return 404, func(w http.ResponseWriter, status int) { sendJSON(w, r, status, notFound()) }
	}
	status := 200
	if r.Method == http.MethodPost {
		status = 201
	}
	b, hasBody := jsonBody(data)
	return status, func(w http.ResponseWriter, status int) { sendBody(w, r, status, b, hasBody) }
}

// jsonBody is tinyhttp's res.json: objects, numbers and booleans as JSON.stringify(v, null, 2),
// strings as they are, null as an empty body.
func jsonBody(v any) ([]byte, bool) {
	switch x := v.(type) {
	case string:
		return []byte(x), true
	case nil, undefinedType:
		return nil, false
	}
	return stringify(v)
}

func sendJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	b, hasBody := jsonBody(v)
	sendBody(w, r, status, b, hasBody)
}

func sendBody(w http.ResponseWriter, r *http.Request, status int, b []byte, hasBody bool) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	if r.Method == http.MethodHead {
		w.WriteHeader(status) // Node sends no Content-Length on HEAD responses
		return
	}
	if !hasBody {
		h.Set("Content-Length", "0")
		w.WriteHeader(status)
		return
	}
	h.Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// sendError is tinyhttp's error handler: plain text, written after the status line, so it goes
// out chunked (no Content-Length).
func sendError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	_, _ = io.WriteString(w, msg)
}

func sendText404(w http.ResponseWriter, r *http.Request) { sendError(w, r, 404, "Not Found") }

// sendText is res.sendStatus: text with an ETag and a Content-Length.
func sendText(w http.ResponseWriter, r *http.Request, status int, text string) {
	send(w, r, status, "text/plain; charset=utf-8", text)
}

// send is tinyhttp's res.send for strings: charset, weak ETag, 304 when the client's copy is fresh.
func send(w http.ResponseWriter, r *http.Request, status int, contentType, body string) {
	h := w.Header()
	h.Set("Content-Type", contentType)
	etag := weakETag(body)
	h.Set("ETag", etag)
	if (status >= 200 && status < 300 || status == 304) && (r.Method == http.MethodGet || r.Method == http.MethodHead) && fresh(r, etag) {
		h.Del("Content-Type")
		w.WriteHeader(304)
		return
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(status)
		return
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func weakETag(body string) string {
	if body == "" {
		return `W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"`
	}
	sum := sha1.Sum([]byte(body))
	return `W/"` + strconv.FormatInt(int64(len(body)), 16) + "-" + base64.StdEncoding.EncodeToString(sum[:])[:27] + `"`
}

var noCache = regexp.MustCompile(`(?:^|,)\s*?no-cache\s*?(?:,|$)`)

func fresh(r *http.Request, etag string) bool {
	modifiedSince, noneMatch := r.Header.Get("If-Modified-Since"), r.Header.Get("If-None-Match")
	if modifiedSince == "" && noneMatch == "" {
		return false
	}
	if noCache.MatchString(r.Header.Get("Cache-Control")) {
		return false
	}
	if noneMatch != "" && noneMatch != "*" {
		match := false
		for _, t := range strings.Split(noneMatch, ",") {
			t = strings.TrimSpace(t)
			if t == etag || "W/"+t == etag || t == "W/"+etag {
				match = true
			}
		}
		if !match {
			return false
		}
	}
	if modifiedSince != "" {
		return false // json-server's responses carry no Last-Modified, so they're always stale
	}
	return true
}

func escapeHTML(s string) string {
	return strings.NewReplacer(`"`, "&quot;", "&", "&amp;", "'", "&#39;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// ---- index page ------------------------------------------------------------------------------

//go:embed index.html
var indexTemplate string

// The Eta template split at its tags, each trailing newline trimmed (Eta's default autoTrim).
var indexParts = func() []string {
	tags := regexp.MustCompile(`<%[\s\S]*?%>`)
	parts := tags.Split(indexTemplate, -1)
	for i := 1; i < len(parts); i++ {
		parts[i] = strings.TrimPrefix(parts[i], "\n")
	}
	if len(parts) != 13 {
		panic(errors.New("index.html: unexpected template structure"))
	}
	return parts
}()

func (s *server) index(w http.ResponseWriter, r *http.Request) {
	p := indexParts
	var b strings.Builder
	b.WriteString(p[0])
	b.WriteString(p[1])
	s.db.mu.RLock()
	keys := s.db.data.Keys()
	if len(keys) == 0 {
		b.WriteString(p[2])
	} else {
		b.WriteString(p[3])
		for _, name := range keys {
			b.WriteString(p[4])
			b.WriteString(xmlEscape(name))
			b.WriteString(p[5])
			b.WriteString(xmlEscape(name))
			b.WriteString(p[6])
			if list, ok := s.db.data.vals[name].([]any); ok {
				b.WriteString(p[7])
				b.WriteString(strconv.Itoa(len(list)))
				b.WriteString(p[8])
			} else {
				b.WriteString(p[9])
			}
			b.WriteString(p[10])
		}
		b.WriteString(p[11])
	}
	s.db.mu.RUnlock()
	b.WriteString(p[12])
	send(w, r, 200, "text/html; charset=utf-8", b.String())
}

// xmlEscape is Eta's default escaping for <%= %>.
func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;").Replace(s)
}
