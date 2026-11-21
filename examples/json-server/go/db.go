package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DB is lowdb + json-server's NormalizedAdapter: the whole file in memory, written back after
// every change, reloaded when someone else edits the file.
type DB struct {
	mu   sync.RWMutex
	path string
	data *Object

	lastSeen fileStamp // the file as we last read or wrote it
}

type fileStamp struct {
	mod  time.Time
	size int64
}

const schemaPath = "./node_modules/json-server/schema.json"

func openDB(path string) (*DB, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if strings.TrimFunc(string(raw), isJSSpace) == "" {
		if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
			return nil, err
		}
		raw = []byte("{}")
	}
	db := &DB{path: path}
	data, err := parseDBFile(raw)
	if err != nil {
		return nil, err
	}
	db.data = data
	db.lastSeen = stampOf(path)
	return db, nil
}

func parseDBFile(raw []byte) (*Object, error) {
	v, err := parseJSON(toValidUTF8(raw))
	if err != nil {
		return nil, fmt.Errorf("SyntaxError: %w", err)
	}
	data, ok := v.(*Object)
	if !ok {
		return nil, errors.New("the database file must contain a JSON object")
	}
	data.Delete("$schema")
	// Numeric ids become strings; items without one get a random id.
	for _, k := range data.Keys() {
		list, ok := data.vals[k].([]any)
		if !ok {
			continue
		}
		for _, it := range list {
			obj, ok := it.(*Object)
			if !ok {
				continue
			}
			switch id := obj.Value("id").(type) {
			case float64:
				obj.Set("id", numberToString(id))
			case undefinedType:
				obj.Set("id", randomID())
			}
		}
	}
	return data, nil
}

func stampOf(path string) fileStamp {
	fi, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	return fileStamp{fi.ModTime(), fi.Size()}
}

// write saves the data as JSON.stringify({...data, $schema}, null, 2), atomically. Caller holds mu.
func (db *DB) write() error {
	out := db.data.Clone()
	out.Set("$schema", schemaPath)
	body, _ := stringify(out)
	tmp := filepath.Join(filepath.Dir(db.path), "."+filepath.Base(db.path)+".tmp")
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, db.path); err != nil {
		return err
	}
	db.lastSeen = stampOf(db.path)
	return nil
}

// watch reloads the file when it changes on disk for any reason other than our own writes
// (json-server does this unless NODE_ENV=production).
func (db *DB) watch(interval time.Duration) {
	for range time.Tick(interval) {
		stamp := stampOf(db.path)
		db.mu.RLock()
		changed := stamp != db.lastSeen && stamp != (fileStamp{})
		db.mu.RUnlock()
		if !changed {
			continue
		}
		raw, err := os.ReadFile(db.path)
		if err != nil {
			continue
		}
		data, err := parseDBFile(raw)
		db.mu.Lock()
		db.lastSeen = stamp
		if err != nil {
			log.Printf("Error parsing %s\n%v", db.path, err)
		} else {
			db.data = data
		}
		db.mu.Unlock()
	}
}
