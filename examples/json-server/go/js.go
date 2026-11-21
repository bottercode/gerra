package main

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// JavaScript semantics json-server relies on implicitly: number formatting, coercion, comparison.

// numberToString is Number.prototype.toString(): shortest round-trip digits, exponent past 1e21 / below 1e-6.
func numberToString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0" // also -0
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// Shortest digits and decimal exponent: f = 0.d1d2...dk × 10^n
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddddde±xx
	mant, expStr, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expStr)
	k, n := len(digits), exp+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	abs := n - 1
	if abs < 0 {
		abs = -abs
	}
	if k == 1 {
		return sign + digits + "e" + expSign + strconv.Itoa(abs)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(abs)
}

// isJSSpace is the WhiteSpace + LineTerminator set String.prototype.trim removes.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

var decimalLiteral = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// stringToNumber is Number(string).
func stringToNumber(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			f := 0.0
			for _, c := range s[2:] {
				d := digitValue(c)
				if d < 0 || d >= base {
					return math.NaN()
				}
				f = f*float64(base) + float64(d)
			}
			return f
		}
	}
	if !decimalLiteral.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

func digitValue(c rune) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'z':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'Z':
		return int(c-'A') + 10
	}
	return -1
}

// parseInt10 is Number.parseInt(s, 10); ok is false for NaN.
func parseInt10(s string) (float64, bool) {
	s = strings.TrimLeftFunc(s, isJSSpace)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, false
	}
	f, _ := strconv.ParseFloat(s[:end], 64)
	if neg {
		f = -f
	}
	return f, true
}

// toString is String(v).
func toString(v any) string {
	switch x := v.(type) {
	case undefinedType:
		return "undefined"
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return numberToString(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e == nil || e == undefined {
				continue
			}
			parts[i] = toString(e)
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// toNumber is Number(v).
func toNumber(v any) float64 {
	switch x := v.(type) {
	case undefinedType:
		return math.NaN()
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return stringToNumber(x)
	}
	return stringToNumber(toString(v)) // objects and arrays go through their string form
}

// strictEquals is ===. Objects and arrays are only equal to themselves.
func strictEquals(a, b any) bool {
	switch x := a.(type) {
	case undefinedType, nil:
		return a == b
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case *Object:
		y, ok := b.(*Object)
		return ok && x == y
	}
	return false
}

func isPrimitive(v any) bool {
	switch v.(type) {
	case *Object, []any:
		return false
	}
	return true
}

func toPrimitive(v any) any {
	if isPrimitive(v) {
		return v
	}
	return toString(v)
}

// lessThan is the abstract relational comparison x < y. defined is false when a NaN is involved
// (every comparison with it is false).
func lessThan(x, y any) (result, defined bool) {
	px, py := toPrimitive(x), toPrimitive(y)
	if sx, ok := px.(string); ok {
		if sy, ok := py.(string); ok {
			return compareUTF16(sx, sy) < 0, true
		}
	}
	nx, ny := toNumber(px), toNumber(py)
	if math.IsNaN(nx) || math.IsNaN(ny) {
		return false, false
	}
	return nx < ny, true
}

func jsLess(x, y any) bool    { r, _ := lessThan(x, y); return r }
func jsGreater(x, y any) bool { r, _ := lessThan(y, x); return r }
func jsLessEq(x, y any) bool {
	r, ok := lessThan(y, x)
	return ok && !r
}
func jsGreaterEq(x, y any) bool {
	r, ok := lessThan(x, y)
	return ok && !r
}

// compareUTF16 orders strings by UTF-16 code units, as JavaScript does (not by code point).
func compareUTF16(a, b string) int {
	for a != "" && b != "" {
		ra, na := utf8.DecodeRuneInString(a)
		rb, nb := utf8.DecodeRuneInString(b)
		if ra != rb {
			ua, ub := utf16Lead(ra), utf16Lead(rb)
			if ua != ub {
				if ua < ub {
					return -1
				}
				return 1
			}
			if ra < rb {
				return -1
			}
			return 1
		}
		a, b = a[na:], b[nb:]
	}
	switch {
	case a == "" && b == "":
		return 0
	case a == "":
		return -1
	}
	return 1
}

func utf16Lead(r rune) rune {
	if r >= 0x10000 {
		hi, _ := utf16.EncodeRune(r)
		return hi
	}
	return r
}

// toLowerJS is String.prototype.toLowerCase for the cases that differ from Go's simple mapping.
func toLowerJS(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "İ", "i̇"))
}

// localeCompare uses the Unicode root collation, as Node's String.prototype.localeCompare does
// under an English (or unset) locale: "apple" < "Banana" < "banana" < "édition" < "zebra".
// A Collator keeps scratch buffers and isn't safe for concurrent use, so each request borrows one.
var collators = sync.Pool{New: func() any { return collate.New(language.Und) }}

func localeCompare(a, b string) int {
	c := collators.Get().(*collate.Collator)
	defer collators.Put(c)
	return c.CompareString(a, b)
}
