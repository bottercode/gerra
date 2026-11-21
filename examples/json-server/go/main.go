// json-server-go: a Go port of json-server 1.0.0-beta.15 (https://github.com/typicode/json-server,
// MIT), written route by route and checked against recorded traffic with gerra.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const version = "1.0.0-beta.15-go"

func usage() {
	fmt.Print(`Usage: json-server-go [options] <file>

Options:
  -p, --port <port>  Port (default: 3000)
  -h, --host <host>  Host (default: localhost)
  --help             Show this message
  --version          Show version number
`)
}

func main() {
	log.SetFlags(0)
	port, host := envOr("PORT", "3000"), envOr("HOST", "localhost")
	var file string
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		a := args[i]
		name, value, hasValue := strings.Cut(a, "=")
		switch name {
		case "-p", "--port", "-h", "--host":
			if !hasValue {
				if i+1 >= len(args) {
					fmt.Printf("Option '%s <value>' argument missing\n", name)
					usage()
					os.Exit(1)
				}
				i++
				value = args[i]
			}
			if name == "-p" || name == "--port" {
				port = value
			} else {
				host = value
			}
		case "-s", "--static":
			fmt.Println("--static is not supported by the Go port yet")
			os.Exit(1)
		case "-w", "--watch":
			fmt.Println("--watch/-w can be omitted, JSON Server 1+ watches for file changes by default")
		case "--help":
			usage()
			return
		case "--version":
			fmt.Println(version)
			return
		default:
			if strings.HasPrefix(a, "-") {
				fmt.Printf("Unknown option '%s'\n", a)
				usage()
				os.Exit(1)
			}
			if file == "" {
				file = a
			}
		}
	}
	if file == "" {
		usage()
		return
	}
	if strings.EqualFold(filepath.Ext(file), ".json5") {
		fmt.Println("JSON5 files are not supported by the Go port yet")
		os.Exit(1)
	}
	if _, err := os.Stat(file); err != nil {
		fmt.Printf("File %s not found\n", file)
		os.Exit(1)
	}
	db, err := openDB(file)
	if err != nil {
		log.Fatal(err)
	}
	if os.Getenv("NODE_ENV") != "production" {
		go db.watch(500 * time.Millisecond)
	}

	fmt.Printf("JSON Server (Go) started on PORT :%s\nPress CTRL-C to stop\nWatching %s...\n\nIndex:\nhttp://localhost:%s/\n\nEndpoints:\n", port, file, port)
	for _, k := range db.data.Keys() {
		fmt.Printf("http://%s:%s/%s\n", host, port, k)
	}
	// Like json-server, listen on every interface; --host only changes the printed URLs.
	srv := &http.Server{Addr: ":" + port, Handler: &server{db: db}, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
