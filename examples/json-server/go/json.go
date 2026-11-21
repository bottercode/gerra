package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// parseJSON is JSON.parse, including V8's error messages: json-server answers a malformed request
// body with the message in a 500, so the text is observable behavior.
func parseJSON(src string) (any, error) {
	p := &jsonParser{src: src}
	p.skipSpace()
	v := p.value()
	if p.err != nil {
		return nil, p.err
	}
	p.skipSpace()
	if p.pos < len(p.src) {
		p.fail(msgNonWhitespaceAfter)
		return nil, p.err
	}
	return v, nil
}

type jsonParser struct {
	src string
	pos int // byte offset
	err error
}

// V8 message templates (src/common/message-template.h); %s marks where "at position N (line L column C)" goes.
const (
	msgExpectedPropNameOrRBrace = "Expected property name or '}' in JSON %s"
	msgExpectedCommaOrRBrack    = "Expected ',' or ']' after array element in JSON %s"
	msgExpectedCommaOrRBrace    = "Expected ',' or '}' after property value in JSON %s"
	msgExpectedColon            = "Expected ':' after property name in JSON %s"
	msgExpectedDoubleQuotedName = "Expected double-quoted property name in JSON %s"
	msgUnterminatedString       = "Unterminated string in JSON %s"
	msgBadControlCharacter      = "Bad control character in string literal in JSON %s"
	msgBadUnicodeEscape         = "Bad Unicode escape in JSON %s"
	msgBadEscapedCharacter      = "Bad escaped character in JSON %s"
	msgNoNumberAfterMinus       = "No number after minus sign in JSON %s"
	msgUnterminatedFraction     = "Unterminated fractional number in JSON %s"
	msgExponentMissingNumber    = "Exponent part is missing a number in JSON %s"
	msgNonWhitespaceAfter       = "Unexpected non-whitespace character after JSON %s"
	msgUnexpectedNumber         = "Unexpected number in JSON %s"
	msgUnexpectedString         = "Unexpected string in JSON %s"
)

// fail reports an error at the current position with a specific message. At the end of input V8 still
// uses the specific message when it has one.
func (p *jsonParser) fail(template string) {
	if p.err == nil {
		p.err = fmt.Errorf(template, p.location())
	}
}

// unexpected reports the character at the current position without a specific message (V8's
// LookUpErrorMessageForJsonToken).
func (p *jsonParser) unexpected() {
	if p.err != nil {
		return
	}
	if p.pos >= len(p.src) {
		p.err = fmt.Errorf("Unexpected end of JSON input")
		return
	}
	switch c := p.src[p.pos]; {
	case c == '"':
		p.fail(msgUnexpectedString)
		return
	case c == '-' || (c >= '0' && c <= '9'):
		p.fail(msgUnexpectedNumber)
		return
	}
	switch p.src {
	case "[object Object]", "undefined", "Infinity", "NaN":
		p.err = fmt.Errorf("%q is not valid JSON", p.src)
		return
	}
	r, _ := utf8.DecodeRuneInString(p.src[p.pos:])
	token := string(r)
	units := utf16.Encode([]rune(p.src))
	pos := p.utf16Pos()
	const ctx = 10 // kMaxContextCharacters
	n := len(units)
	sub := func(from, to int) string { return string(utf16.Decode(units[max(from, 0):min(to, n)])) }
	switch {
	case n <= 2*ctx: // kMinOriginalSourceLengthForContext = 21
		p.err = fmt.Errorf("Unexpected token '%s', \"%s\" is not valid JSON", token, p.src)
	case pos < ctx:
		p.err = fmt.Errorf("Unexpected token '%s', \"%s\"... is not valid JSON", token, sub(0, pos+ctx))
	case pos < n-ctx:
		p.err = fmt.Errorf("Unexpected token '%s', ...\"%s\"... is not valid JSON", token, sub(pos-ctx, pos+ctx))
	default:
		p.err = fmt.Errorf("Unexpected token '%s', ...\"%s\" is not valid JSON", token, sub(pos-ctx, n))
	}
}

func (p *jsonParser) utf16Pos() int {
	n := 0
	for _, r := range p.src[:min(p.pos, len(p.src))] {
		n += utf16.RuneLen(r)
	}
	return n
}

func (p *jsonParser) location() string {
	pos := p.utf16Pos()
	line, col := 1, pos+1
	if i := strings.LastIndexByte(p.src[:min(p.pos, len(p.src))], '\n'); i >= 0 {
		line = strings.Count(p.src[:i], "\n") + 2
		col = pos - (&jsonParser{src: p.src, pos: i}).utf16Pos()
	}
	return fmt.Sprintf("at position %d (line %d column %d)", pos, line, col)
}

func (p *jsonParser) skipSpace() {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jsonParser) peek() byte {
	if p.pos < len(p.src) {
		return p.src[p.pos]
	}
	return 0
}

func (p *jsonParser) value() any {
	if p.err != nil {
		return nil
	}
	switch c := p.peek(); {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.string()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == 't':
		p.literal("true")
		return true
	case c == 'f':
		p.literal("false")
		return false
	case c == 'n':
		p.literal("null")
		return nil
	}
	p.unexpected()
	return nil
}

func (p *jsonParser) literal(word string) {
	for i := 0; i < len(word); i++ {
		if p.pos >= len(p.src) {
			p.unexpected()
			return
		}
		if p.src[p.pos] != word[i] {
			p.unexpected()
			return
		}
		p.pos++
	}
}

func (p *jsonParser) object() any {
	p.pos++ // {
	obj := newObject(8)
	p.skipSpace()
	if p.peek() == '}' {
		p.pos++
		return obj
	}
	first := true
	for {
		if p.peek() != '"' {
			if first {
				p.fail(msgExpectedPropNameOrRBrace)
			} else {
				p.fail(msgExpectedDoubleQuotedName)
			}
			return nil
		}
		key := p.string()
		if p.err != nil {
			return nil
		}
		p.skipSpace()
		if p.peek() != ':' {
			p.fail(msgExpectedColon)
			return nil
		}
		p.pos++
		p.skipSpace()
		v := p.value()
		if p.err != nil {
			return nil
		}
		obj.Set(key.(string), v)
		p.skipSpace()
		switch p.peek() {
		case ',':
			p.pos++
			p.skipSpace()
			first = false
		case '}':
			p.pos++
			return obj
		default:
			p.fail(msgExpectedCommaOrRBrace)
			return nil
		}
	}
}

func (p *jsonParser) array() any {
	p.pos++ // [
	arr := []any{}
	p.skipSpace()
	if p.peek() == ']' {
		p.pos++
		return arr
	}
	for {
		v := p.value()
		if p.err != nil {
			return nil
		}
		arr = append(arr, v)
		p.skipSpace()
		switch p.peek() {
		case ',':
			p.pos++
			p.skipSpace()
		case ']':
			p.pos++
			return arr
		default:
			p.fail(msgExpectedCommaOrRBrack)
			return nil
		}
	}
}

func (p *jsonParser) string() any {
	p.pos++ // opening quote
	var b strings.Builder
	start := p.pos
	for {
		if p.pos >= len(p.src) {
			p.fail(msgUnterminatedString)
			return nil
		}
		c := p.src[p.pos]
		switch {
		case c == '"':
			b.WriteString(p.src[start:p.pos])
			p.pos++
			return b.String()
		case c < 0x20:
			p.fail(msgBadControlCharacter)
			return nil
		case c == '\\':
			b.WriteString(p.src[start:p.pos])
			p.pos++
			if p.pos >= len(p.src) {
				p.fail(msgUnterminatedString)
				return nil
			}
			switch e := p.src[p.pos]; e {
			case '"', '\\', '/':
				b.WriteByte(e)
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'u':
				r, ok := p.hex4(p.pos + 1)
				if !ok {
					return nil
				}
				p.pos += 4
				if utf16.IsSurrogate(r) && r < 0xDC00 && p.pos+6 < len(p.src) && p.src[p.pos+1] == '\\' && p.src[p.pos+2] == 'u' {
					if r2, ok := p.hex4(p.pos + 3); ok && r2 >= 0xDC00 && r2 <= 0xDFFF {
						r = utf16.DecodeRune(r, r2)
						p.pos += 6
					} else if p.err != nil {
						return nil
					}
				}
				writeWTF8(&b, r)
			default:
				p.fail(msgBadEscapedCharacter)
				return nil
			}
			p.pos++
			start = p.pos
		default:
			p.pos++
		}
	}
}

func (p *jsonParser) hex4(at int) (rune, bool) {
	var r rune
	for i := 0; i < 4; i++ {
		if at+i >= len(p.src) {
			p.pos = at + i
			p.fail(msgBadUnicodeEscape)
			return 0, false
		}
		d := digitValue(rune(p.src[at+i]))
		if d < 0 || d > 15 {
			p.pos = at + i
			p.fail(msgBadUnicodeEscape)
			return 0, false
		}
		r = r*16 + rune(d)
	}
	return r, true
}

// writeWTF8 keeps lone surrogates (valid in JavaScript strings) as their 3-byte encoding so they
// round-trip through stringify as \udxxx.
func writeWTF8(b *strings.Builder, r rune) {
	if utf16.IsSurrogate(r) {
		b.WriteByte(byte(0xE0 | r>>12))
		b.WriteByte(byte(0x80 | (r>>6)&0x3F))
		b.WriteByte(byte(0x80 | r&0x3F))
		return
	}
	b.WriteRune(r)
}

func (p *jsonParser) number() any {
	start := p.pos
	if p.peek() == '-' {
		p.pos++
		if c := p.peek(); c < '0' || c > '9' {
			p.fail(msgNoNumberAfterMinus)
			return nil
		}
	}
	if p.peek() == '0' {
		p.pos++
		if c := p.peek(); c >= '0' && c <= '9' { // leading zero: V8 points at the next digit
			p.fail(msgUnexpectedNumber)
			return nil
		}
	} else {
		p.digits()
	}
	if p.peek() == '.' {
		p.pos++
		if c := p.peek(); c < '0' || c > '9' {
			p.fail(msgUnterminatedFraction)
			return nil
		}
		p.digits()
	}
	if c := p.peek(); c == 'e' || c == 'E' {
		p.pos++
		if c := p.peek(); c == '+' || c == '-' {
			p.pos++
		}
		if c := p.peek(); c < '0' || c > '9' {
			p.fail(msgExponentMissingNumber)
			return nil
		}
		p.digits()
	}
	f, _ := strconv.ParseFloat(p.src[start:p.pos], 64) // out of range → ±Inf, like JavaScript
	return f
}

func (p *jsonParser) digits() {
	for c := p.peek(); c >= '0' && c <= '9'; c = p.peek() {
		p.pos++
	}
}

// stringify is JSON.stringify(v, null, 2). It returns ok=false for undefined (nothing to send).
func stringify(v any) ([]byte, bool) {
	if v == undefined {
		return nil, false
	}
	var b strings.Builder
	writeJSON(&b, v, "")
	return []byte(b.String()), true
}

func writeJSON(b *strings.Builder, v any, indent string) {
	switch x := v.(type) {
	case nil, undefinedType:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(numberToString(x))
		}
	case string:
		writeQuoted(b, x)
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		inner := indent + "  "
		b.WriteString("[\n")
		for i, e := range x {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			writeJSON(b, e, inner)
		}
		b.WriteString("\n" + indent + "]")
	case *Object:
		inner := indent + "  "
		wrote := false
		for _, k := range x.Keys() {
			e := x.vals[k]
			if e == undefined {
				continue
			}
			if wrote {
				b.WriteString(",\n")
			} else {
				b.WriteString("{\n")
			}
			wrote = true
			b.WriteString(inner)
			writeQuoted(b, k)
			b.WriteString(": ")
			writeJSON(b, e, inner)
		}
		if !wrote {
			b.WriteString("{}")
			return
		}
		b.WriteString("\n" + indent + "}")
	default:
		b.WriteString("null")
	}
}

const hexDigits = "0123456789abcdef"

// writeQuoted quotes like JSON.stringify: only ", \ and control characters are escaped; lone
// surrogates become \udxxx.
func writeQuoted(b *strings.Builder, s string) {
	b.WriteByte('"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < 0x80 {
			i++
			continue
		}
		if c >= 0x80 {
			if c == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 { // WTF-8 lone surrogate
				b.WriteString(s[start:i])
				r := rune(c&0x0F)<<12 | rune(s[i+1]&0x3F)<<6 | rune(s[i+2]&0x3F)
				fmt.Fprintf(b, `\u%04x`, r)
				i += 3
				start = i
				continue
			}
			_, n := utf8.DecodeRuneInString(s[i:])
			i += n
			continue
		}
		b.WriteString(s[start:i])
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteString(`\u00`)
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xF])
		}
		i++
		start = i
	}
	b.WriteString(s[start:])
	b.WriteByte('"')
}
