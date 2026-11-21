// bench replays the GET requests of a gerra tape against a server as fast as it answers, from
// a fixed number of keep-alive connections, and reports throughput and latency.
//
//	go run ./cmd/bench -tape ../../../.gerra/tapes/jsonserver-reads.jsonl -target http://localhost:3000
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	tape := flag.String("tape", "", "gerra tape (JSONL)")
	target := flag.String("target", "http://localhost:3000", "server to load")
	conns := flag.Int("c", 32, "concurrent connections")
	duration := flag.Duration("d", 10*time.Second, "measured duration")
	warmup := flag.Duration("warmup", 2*time.Second, "unmeasured warm-up")
	flag.Parse()

	urls, err := readGETs(*tape, *target)
	if err != nil || len(urls) == 0 {
		fmt.Fprintln(os.Stderr, "bench: no GET requests in tape:", err)
		os.Exit(2)
	}
	client := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: *conns, MaxConnsPerHost: *conns, DisableCompression: true}}

	var measuring atomic.Bool
	var stop atomic.Bool
	var errors atomic.Int64
	latencies := make([][]time.Duration, *conns)
	var bytes atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < *conns; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := w; !stop.Load(); i += *conns {
				start := time.Now()
				res, err := client.Get(urls[i%len(urls)])
				if err != nil {
					errors.Add(1)
					continue
				}
				n, _ := io.Copy(io.Discard, res.Body)
				res.Body.Close()
				if measuring.Load() {
					latencies[w] = append(latencies[w], time.Since(start))
					bytes.Add(n)
				}
			}
		}(w)
	}
	time.Sleep(*warmup)
	measuring.Store(true)
	began := time.Now()
	time.Sleep(*duration)
	measuring.Store(false)
	elapsed := time.Since(began)
	stop.Store(true)
	wg.Wait()

	var all []time.Duration
	for _, l := range latencies {
		all = append(all, l...)
	}
	slices.Sort(all)
	pct := func(p float64) float64 { return float64(all[int(float64(len(all)-1)*p)].Microseconds()) / 1000 }
	out := map[string]any{
		"target": *target, "connections": *conns, "seconds": elapsed.Seconds(), "requests": len(all),
		"rps": float64(len(all)) / elapsed.Seconds(), "p50_ms": pct(0.50), "p99_ms": pct(0.99), "max_ms": pct(1),
		"mb_per_s": float64(bytes.Load()) / elapsed.Seconds() / 1e6, "errors": errors.Load(), "distinct_requests": len(urls),
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)
}

func readGETs(path, target string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var urls []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var ex struct {
			Request struct {
				Method, Path, Query string
			}
		}
		if json.Unmarshal(sc.Bytes(), &ex) != nil || ex.Request.Method != "GET" {
			continue
		}
		u := target + ex.Request.Path
		if ex.Request.Query != "" {
			u += "?" + ex.Request.Query
		}
		urls = append(urls, u)
	}
	return urls, sc.Err()
}
