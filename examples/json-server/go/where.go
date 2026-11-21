package main

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ---- query strings -------------------------------------------------------------------------

type param struct{ key, value string }

// parseQuery is URLSearchParams (and node:querystring, which agrees on everything json-server
// uses): pairs split on &, + is a space, malformed %-escapes stay as written.
func parseQuery(q string) []param {
	var out []param
	for _, part := range strings.Split(q, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		out = append(out, param{formDecode(k), formDecode(v)})
	}
	return out
}

func formDecode(s string) string {
	if !strings.ContainsAny(s, "+%") {
		return s
	}
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '+':
			b = append(b, ' ')
		case c == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]):
			b = append(b, byte(digitValue(rune(s[i+1]))<<4|digitValue(rune(s[i+2]))))
			i += 2
		default:
			b = append(b, c)
		}
	}
	return toValidUTF8(b)
}

func isHex(c byte) bool { return digitValue(rune(c)) >= 0 && digitValue(rune(c)) < 16 }

// toValidUTF8 replaces each invalid byte with U+FFFD, like Buffer#toString / TextDecoder.
func toValidUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		sb.WriteRune(r)
		b = b[n:]
	}
	return sb.String()
}

func queryGet(params []param, key string) (string, bool) {
	for _, p := range params {
		if p.key == key {
			return p.value, true
		}
	}
	return "", false
}

func queryAll(params []param, key string) []string {
	var out []string
	for _, p := range params {
		if p.key == key {
			out = append(out, p.value)
		}
	}
	return out
}

// errURI is decodeURIComponent's URIError.
var errURI = errors.New("URI malformed")

// decodeURIComponent: %XX sequences must form valid UTF-8; + stays a plus.
func decodeURIComponent(s string) (string, error) {
	if !strings.Contains(s, "%") {
		return s, nil
	}
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b = append(b, s[i])
			continue
		}
		if i+2 >= len(s) || !isHex(s[i+1]) || !isHex(s[i+2]) {
			return "", errURI
		}
		b = append(b, byte(digitValue(rune(s[i+1]))<<4|digitValue(rune(s[i+2]))))
		i += 2
	}
	if !utf8.Valid(b) {
		return "", errURI
	}
	return string(b), nil
}

// ---- dot-prop paths ------------------------------------------------------------------------

// A path segment is a property name (string) or an array index (int).
type segment = any

var disallowedKeys = map[string]bool{"__proto__": true, "prototype": true, "constructor": true}

// parsePath is dot-prop's parsePath: "a.b", "a\.b", "a[0].b". Disallowed keys give an empty path.
func parsePath(path string) ([]segment, error) {
	var parts []segment
	current, index := "", ""
	hadProperty, escaping := false, false
	state := "start"
	position := 0
	process := func(s string) bool {
		if disallowedKeys[s] {
			return false
		}
		if s != "" && shouldCoerceToNumber(s) {
			n, _ := strconv.Atoi(s)
			parts = append(parts, n)
		} else {
			parts = append(parts, s)
		}
		return true
	}
	for _, ch := range path {
		position++
		if escaping {
			current += string(ch)
			escaping = false
			continue
		}
		if ch == '\\' {
			if state == "index" {
				return nil, fmt.Errorf("Invalid character '%c' in an index at position %d", ch, position)
			}
			if state == "indexEnd" {
				return nil, fmt.Errorf("Invalid character '%c' after an index at position %d", ch, position)
			}
			escaping = true
			if state == "start" {
				state = "property"
			}
			continue
		}
		switch ch {
		case '.':
			if state == "index" {
				return nil, fmt.Errorf("Invalid character '%c' in an index at position %d", ch, position)
			}
			if state == "indexEnd" {
				state = "property"
				continue
			}
			if !process(current) {
				return nil, nil
			}
			current = ""
			state = "property"
		case '[':
			if state == "index" {
				return nil, fmt.Errorf("Invalid character '%c' in an index at position %d", ch, position)
			}
			if state == "indexEnd" {
				state = "index"
				continue
			}
			if state == "property" && disallowedKeys[current] {
				return nil, nil
			}
			hadProperty = state == "property"
			state = "index"
		case ']':
			if state == "indexEnd" {
				return nil, fmt.Errorf("Invalid character '%c' after an index at position %d", ch, position)
			}
			if state != "index" {
				if state == "start" {
					state = "property"
				}
				current += string(ch)
				continue
			}
			if index == "" {
				current += "[]"
				state = "property"
				continue
			}
			if (current != "" || hadProperty) && !process(current) {
				return nil, nil
			}
			current = ""
			hadProperty = false
			if n, err := strconv.Atoi(index); err == nil && n <= 1_000_000 && strconv.Itoa(n) == index {
				parts = append(parts, n)
			} else {
				parts = append(parts, index)
			}
			index = ""
			state = "indexEnd"
		default:
			if state == "index" {
				if ch < '0' || ch > '9' {
					return nil, fmt.Errorf("Invalid character '%c' in an index at position %d", ch, position)
				}
				index += string(ch)
				continue
			}
			if state == "indexEnd" {
				return nil, fmt.Errorf("Invalid character '%c' after an index at position %d", ch, position)
			}
			if state == "start" {
				state = "property"
			}
			current += string(ch)
		}
	}
	if escaping {
		current += "\\"
	}
	switch state {
	case "property":
		if !process(current) {
			return nil, nil
		}
	case "index":
		return nil, errors.New("Index was not closed")
	case "start":
		parts = append(parts, "")
	}
	return parts, nil
}

var positiveInt = regexp.MustCompile(`^[1-9]\d*$`)

func shouldCoerceToNumber(s string) bool {
	if s == "0" {
		return true
	}
	if positiveInt.MatchString(s) {
		n, err := strconv.ParseFloat(s, 64)
		return err == nil && n <= 1_000_000
	}
	return false
}

func segmentKey(s segment) string {
	if n, ok := s.(int); ok {
		return strconv.Itoa(n)
	}
	return s.(string)
}

// member is obj[key] for the values json-server stores.
func member(v any, key string) any {
	switch x := v.(type) {
	case *Object:
		return x.Value(key)
	case []any:
		if key == "length" {
			return float64(len(x))
		}
		if isArrayIndex(key) {
			if i, _ := strconv.Atoi(key); i < len(x) {
				return x[i]
			}
		}
	}
	return undefined
}

func isObjectLike(v any) bool { return !isPrimitive(v) }

// getProperty is dot-prop's getProperty(obj, path).
func getProperty(obj any, path string) (any, error) {
	if !isObjectLike(obj) {
		return obj, nil
	}
	parts, err := parsePath(path)
	if err != nil || len(parts) == 0 {
		return undefined, err
	}
	for i, p := range parts {
		obj = member(obj, segmentKey(p))
		if obj == undefined || obj == nil {
			if i != len(parts)-1 {
				return undefined, nil
			}
			break
		}
	}
	return obj, nil
}

// setProperty is dot-prop's setProperty on the plain objects parseWhere builds.
func setProperty(root *Object, path string, value any) error {
	parts, err := parsePath(path)
	if err != nil || len(parts) == 0 {
		return err
	}
	var obj any = root
	for i, p := range parts {
		key := segmentKey(p)
		last := i == len(parts)-1
		switch o := obj.(type) {
		case *Object:
			if last {
				o.Set(key, value)
				continue
			}
			if next := o.Value(key); isObjectLike(next) {
				obj = next
				continue
			}
			var fresh any = newObject(1)
			if _, isIndex := parts[i+1].(int); isIndex {
				fresh = []any{} // an array filter never matches; its contents don't matter
			}
			o.Set(key, fresh)
			obj = fresh
		default:
			return nil // inside an array: invisible to matchesWhere
		}
	}
	return nil
}

// ---- where -----------------------------------------------------------------------------------

var whereOperators = []string{"lt", "lte", "gt", "gte", "eq", "ne", "in", "contains", "startsWith", "endsWith"}

func isWhereOperator(s string) bool {
	for _, op := range whereOperators {
		if op == s {
			return true
		}
	}
	return false
}

var underscoreOperator = regexp.MustCompile(`^(.*)_([a-z]+)$`)

// splitKey: "views:gt" → (views, gt); "views_gt" (v0.17 style) → (views, gt); "views" → (views, eq).
// ok is false for an unknown "path:op", which is skipped.
func splitKey(key string) (path, op string, ok bool) {
	if i := strings.LastIndexByte(key, ':'); i != -1 {
		path, op = key[:i], key[i+1:]
		if op == "" {
			return key, "eq", true
		}
		if isWhereOperator(op) {
			return path, op, true
		}
		return "", "", false
	}
	if m := underscoreOperator.FindStringSubmatch(key); m != nil && m[1] != "" && isWhereOperator(m[2]) {
		return m[1], m[2], true
	}
	return key, "eq", true
}

// coerceValue turns query strings into the JSON values they look like: "true", "null", "42".
func coerceValue(v string) any {
	switch v {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	if jsTrim(v) == "" {
		return v
	}
	if n := stringToNumber(v); !isNaNOrInf(n) {
		return n
	}
	return v
}

func isNaNOrInf(f float64) bool {
	return f != f || f > 1.7976931348623157e308 || f < -1.7976931348623157e308
}

// parseWhere turns filter query params into a where object: views:gt=10 → {views: {gt: 10}}.
func parseWhere(params []param) (*Object, error) {
	out := newObject(len(params))
	for _, p := range params {
		path, op, ok := splitKey(p.key)
		if !ok {
			continue
		}
		var value any
		if op == "in" {
			var list []any
			for _, part := range strings.Split(p.value, ",") {
				list = append(list, coerceValue(jsTrim(part)))
			}
			value = list
		} else {
			value = coerceValue(p.value)
		}
		if err := setProperty(out, path+"."+op, value); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// entries is Object.entries for a where clause (a JSON object, or an array from _where).
func entries(v any) ([]string, []any) {
	switch x := v.(type) {
	case *Object:
		keys := x.Keys()
		vals := make([]any, len(keys))
		for i, k := range keys {
			vals[i] = x.vals[k]
		}
		return keys, vals
	case []any:
		keys := make([]string, len(x))
		for i := range x {
			keys[i] = strconv.Itoa(i)
		}
		return keys, x
	}
	return nil, nil
}

func matchesWhere(obj any, where any) bool {
	keys, vals := entries(where)
	for i, key := range keys {
		value := vals[i]
		if key == "or" {
			list, ok := value.([]any)
			if !ok || len(list) == 0 {
				return false
			}
			matched := false
			for _, sub := range list {
				if isJSONObject(sub) && matchesWhere(obj, sub) {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
			continue
		}
		field := member(obj, key)
		op, isObj := value.(*Object)
		if !isObj {
			return false // a bare value never matches (json-server only builds {op: value})
		}
		known := map[string]bool{}
		for _, name := range whereOperators {
			if _, ok := op.Get(name); ok {
				known[name] = true
			}
		}
		if len(known) == 0 {
			if isJSONObject(field) && !matchesWhere(field, op) {
				return false
			}
			continue
		}
		if field == undefined {
			return false
		}
		if known["lt"] && !jsLess(field, op.Value("lt")) {
			return false
		}
		if known["lte"] && !jsLessEq(field, op.Value("lte")) {
			return false
		}
		if known["gt"] && !jsGreater(field, op.Value("gt")) {
			return false
		}
		if known["gte"] && !jsGreaterEq(field, op.Value("gte")) {
			return false
		}
		if known["eq"] && !strictEquals(field, op.Value("eq")) {
			return false
		}
		if known["ne"] && strictEquals(field, op.Value("ne")) {
			return false
		}
		if known["in"] {
			in, ok := op.Value("in").([]any)
			if !ok {
				in = []any{op.Value("in")}
			}
			found := false
			for _, v := range in {
				if strictEquals(field, v) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		for _, name := range []string{"contains", "startsWith", "endsWith"} {
			if !known[name] {
				continue
			}
			s, ok := field.(string)
			if !ok {
				return false
			}
			s, needle := toLowerJS(s), toLowerJS(toString(op.Value(name)))
			var hit bool
			switch name {
			case "contains":
				hit = strings.Contains(s, needle)
			case "startsWith":
				hit = strings.HasPrefix(s, needle)
			default:
				hit = strings.HasSuffix(s, needle)
			}
			if !hit {
				return false
			}
		}
	}
	return true
}
