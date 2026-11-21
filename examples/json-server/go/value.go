package main

import (
	"sort"
	"strconv"
)

// JSON values are represented the way JavaScript sees them:
//   nil (null), bool, float64 (every number is a double), string, []any, *Object, and undefined.
// Objects keep JavaScript's key order: integer-like keys ascending first, then the rest in insertion order.

type undefinedType struct{}

// undefined is a property that exists but holds `undefined`: JSON.stringify skips it in objects.
var undefined = undefinedType{}

type Object struct {
	keys    []string
	vals    map[string]any
	indexed bool // has an array-index-like key, so keys need reordering on read
}

func newObject(capacity int) *Object {
	return &Object{keys: make([]string, 0, capacity), vals: make(map[string]any, capacity)}
}

func (o *Object) Get(k string) (any, bool) {
	v, ok := o.vals[k]
	return v, ok
}

// Value returns the property or undefined, like `obj[k]` for own properties.
func (o *Object) Value(k string) any {
	if v, ok := o.vals[k]; ok {
		return v
	}
	return undefined
}

func (o *Object) Set(k string, v any) {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
		if isArrayIndex(k) {
			o.indexed = true
		}
	}
	o.vals[k] = v
}

func (o *Object) Delete(k string) {
	if _, ok := o.vals[k]; !ok {
		return
	}
	delete(o.vals, k)
	for i, key := range o.keys {
		if key == k {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *Object) Len() int { return len(o.keys) }

// Keys in JavaScript property order.
func (o *Object) Keys() []string {
	if !o.indexed {
		return o.keys
	}
	var idx, rest []string
	for _, k := range o.keys {
		if isArrayIndex(k) {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(idx, func(i, j int) bool {
		a, _ := strconv.ParseUint(idx[i], 10, 64)
		b, _ := strconv.ParseUint(idx[j], 10, 64)
		return a < b
	})
	return append(idx, rest...)
}

// Clone is a shallow copy, like `{ ...o }`.
func (o *Object) Clone() *Object {
	c := newObject(len(o.keys) + 1)
	for _, k := range o.Keys() {
		c.Set(k, o.vals[k])
	}
	return c
}

// Assign copies src's properties onto o, like `{ ...o, ...src }`.
func (o *Object) Assign(src *Object) {
	for _, k := range src.Keys() {
		o.Set(k, src.vals[k])
	}
}

// isArrayIndex: a canonical decimal integer below 2^32-1 ("0", "42"; not "01" or "-1").
func isArrayIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < 1<<32-1
}

func isJSONObject(v any) bool {
	_, ok := v.(*Object)
	return ok
}
