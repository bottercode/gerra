package main

import (
	"crypto/rand"
	"encoding/base64"
	"math"
	"sort"
	"strings"
)

// A port of json-server's lib/service.js. Methods expect the caller to hold the db lock.

type findOptions struct {
	where   any
	sort    string
	page    *float64
	perPage *float64
	embed   []string
}

func randomID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (db *DB) get(name string) any { return db.data.Value(name) }

// errTypeError is a JavaScript TypeError thrown by json-server's own code; tinyhttp answers it with a 500.
type errTypeError struct{ msg string }

func (e errTypeError) Error() string { return e.msg }

func embed(db *DB, name string, item any, related string) (any, error) {
	obj, ok := item.(*Object)
	if !ok {
		return item, nil // {...primitive} isn't something json-server data contains
	}
	if singularize(related) == related {
		relatedData := db.get(pluralize(related))
		if !truthy(relatedData) {
			return item, nil
		}
		list, ok := relatedData.([]any)
		if !ok {
			return nil, errTypeError{"relatedData.find is not a function"}
		}
		var found any = undefined
		fk := obj.Value(related + "Id")
		for _, r := range list {
			if strictEquals(member(r, "id"), fk) {
				found = r
				break
			}
		}
		out := obj.Clone()
		out.Set(related, found)
		return out, nil
	}
	relatedData := db.get(related)
	if !truthy(relatedData) {
		return item, nil
	}
	list, ok := relatedData.([]any)
	if !ok {
		return nil, errTypeError{"relatedData.filter is not a function"}
	}
	fk := singularize(name) + "Id"
	id := obj.Value("id")
	matches := []any{}
	for _, r := range list {
		if strictEquals(member(r, fk), id) {
			matches = append(matches, r)
		}
	}
	out := obj.Clone()
	out.Set(related, matches)
	return out, nil
}

func truthy(v any) bool {
	switch x := v.(type) {
	case undefinedType, nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

func (db *DB) findByID(name, id string, embeds []string) (any, error) {
	items, ok := db.get(name).([]any)
	if !ok {
		return undefined, nil
	}
	var item any = undefined
	for _, it := range items {
		if strictEquals(member(it, "id"), id) {
			item = it
			break
		}
	}
	for _, related := range embeds {
		if item != undefined {
			var err error
			if item, err = embed(db, name, item, related); err != nil {
				return nil, err
			}
		}
	}
	return item, nil
}

func (db *DB) find(name string, opts findOptions) (any, error) {
	value := db.get(name)
	items, ok := value.([]any)
	if !ok {
		return value, nil
	}
	results := items
	for _, related := range opts.embed {
		next := make([]any, len(results))
		for i, it := range results {
			e, err := embed(db, name, it, related)
			if err != nil {
				return nil, err
			}
			next[i] = e
		}
		results = next
	}
	filtered := make([]any, 0, len(results))
	for _, it := range results {
		if matchesWhere(it, opts.where) {
			filtered = append(filtered, it)
		}
	}
	results = filtered
	if opts.sort != "" {
		sorted, err := sortOn(results, strings.Split(opts.sort, ","))
		if err != nil {
			return nil, err
		}
		results = sorted
	}
	if opts.page != nil {
		perPage := 10.0
		if opts.perPage != nil {
			perPage = *opts.perPage
		}
		return paginate(results, *opts.page, perPage), nil
	}
	return results, nil
}

// sortOn is the sort-on package: fields compared in turn, "-field" descends, missing/falsy values
// go last (first when descending), strings use localeCompare. Array.prototype.sort is stable.
func sortOn(items []any, fields []string) ([]any, error) {
	type key struct {
		path string
		desc bool
	}
	keys := make([]key, len(fields))
	for i, f := range fields {
		desc := strings.HasPrefix(f, "-")
		if desc {
			f = f[1:]
		}
		keys[i] = key{f, desc}
	}
	// Resolve each item's sort values once (getProperty parses the path, which may fail).
	values := make([][]any, len(items))
	for i, it := range items {
		values[i] = make([]any, len(keys))
		for j, k := range keys {
			v, err := getProperty(it, k.path)
			if err != nil {
				return nil, err
			}
			values[i][j] = v
		}
	}
	order := make([]int, len(items))
	for i := range order {
		order[i] = i
	}
	compare := func(a, b int) int {
		for j, k := range keys {
			x, y := values[a][j], values[b][j]
			if strictEquals(x, y) {
				continue
			}
			if !truthyOrZero(y) {
				return pick(k.desc, 1, -1)
			}
			if !truthyOrZero(x) {
				return pick(k.desc, -1, 1)
			}
			sx, xs := x.(string)
			sy, ys := y.(string)
			if xs && ys {
				r := localeCompare(sx, sy)
				if k.desc {
					r = -r
				}
				if r != 0 {
					return r
				}
				continue
			}
			if jsLess(x, y) {
				return pick(k.desc, 1, -1)
			}
			return pick(k.desc, -1, 1)
		}
		return 0
	}
	sort.SliceStable(order, func(i, j int) bool { return compare(order[i], order[j]) < 0 })
	out := make([]any, len(items))
	for i, idx := range order {
		out[i] = items[idx]
	}
	return out, nil
}

// truthyOrZero is sort-on's `v === 0 || v` test.
func truthyOrZero(v any) bool {
	if f, ok := v.(float64); ok && f == 0 {
		return true
	}
	return truthy(v)
}

func pick(cond bool, a, b int) int {
	if cond {
		return a
	}
	return b
}

func paginate(items []any, page, perPage float64) *Object {
	total := float64(len(items))
	safePerPage := 1.0
	if !math.IsInf(perPage, 0) && !math.IsNaN(perPage) && perPage > 0 {
		safePerPage = math.Floor(perPage)
	}
	pages := math.Max(1, math.Ceil(total/safePerPage))
	safePage := 1.0
	if !math.IsInf(page, 0) && !math.IsNaN(page) {
		safePage = math.Floor(page)
	}
	current := math.Max(1, math.Min(safePage, pages))
	var prev, next any = nil, nil
	if current > 1 {
		prev = current - 1
	}
	if current < pages {
		next = current + 1
	}
	start := (current - 1) * safePerPage
	end := start + safePerPage
	data := items[int(math.Min(start, total)):int(math.Min(end, total))]
	out := newObject(7)
	out.Set("first", 1.0)
	out.Set("prev", prev)
	out.Set("next", next)
	out.Set("last", pages)
	out.Set("pages", pages)
	out.Set("items", total)
	out.Set("data", data)
	return out
}

func (db *DB) create(name string, data *Object) (any, error) {
	items, ok := db.get(name).([]any)
	if !ok {
		return undefined, nil
	}
	item := data.Clone()
	item.Set("id", randomID())
	db.data.Set(name, append(items, item))
	return item, db.write()
}

func (db *DB) updateOrPatch(name string, body *Object, isPatch bool) (any, error) {
	item := db.get(name)
	if item == undefined {
		return undefined, nil
	}
	if _, isArray := item.([]any); isArray {
		return undefined, nil
	}
	next := body
	if isPatch {
		next = newObject(0)
		if obj, ok := item.(*Object); ok {
			next.Assign(obj)
		}
		next.Assign(body)
	}
	db.data.Set(name, next)
	return next, db.write()
}

func (db *DB) updateOrPatchByID(name, id string, body *Object, isPatch bool) (any, error) {
	items, ok := db.get(name).([]any)
	if !ok {
		return undefined, nil
	}
	for i, it := range items {
		obj, ok := it.(*Object)
		if !ok || !strictEquals(obj.Value("id"), id) {
			continue
		}
		next := newObject(obj.Len() + 1)
		if isPatch {
			next.Assign(obj)
		}
		next.Assign(body)
		next.Set("id", id)
		items[i] = next
		return next, db.write()
	}
	return undefined, nil
}

func (db *DB) destroyByID(name, id string, dependents []string) (any, error) {
	items, ok := db.get(name).([]any)
	if !ok {
		return undefined, nil
	}
	index := -1
	for i, it := range items {
		if strictEquals(member(it, "id"), id) {
			index = i
			break
		}
	}
	if index == -1 {
		return undefined, nil
	}
	item := items[index]
	db.data.Set(name, append(items[:index:index], items[index+1:]...))

	// Nullify foreign keys pointing at the deleted item, then drop dependents whose key is null.
	fk := singularize(name) + "Id"
	for _, key := range db.data.Keys() {
		if key == name {
			continue
		}
		if list, ok := db.data.vals[key].([]any); ok {
			for _, it := range list {
				if obj, ok := it.(*Object); ok && strictEquals(obj.Value(fk), id) {
					obj.Set(fk, nil)
				}
			}
		}
	}
	for _, key := range db.data.Keys() {
		if key == name || !contains(dependents, key) {
			continue
		}
		if list, ok := db.data.vals[key].([]any); ok {
			kept := make([]any, 0, len(list))
			for _, it := range list {
				if member(it, fk) != nil {
					kept = append(kept, it)
				}
			}
			db.data.Set(key, kept)
		}
	}
	return item, db.write()
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
