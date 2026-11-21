# @gerra/dashboard

A local, read-only web dashboard for [gerra](https://www.npmjs.com/package/@gerra/cli). Run it in the directory that holds `.gerra/`:

```bash
npx @gerra/dashboard            # http://localhost:7700  (--port to change)
```

- **Tapes:** every recorded tape and how each replay of it went over time.
- **Runs:** a replay's differences grouped by route, with example requests.
- **Exchanges:** the recorded answer and the rewrite's answer side by side, with the places that differ highlighted, plus side effects (outbound calls, queries) when the services report them.
- **Live:** running `gerra shadow` and `gerra cutover` sessions, refreshed every 2 seconds.

It listens on 127.0.0.1 only, answers only requests addressed to `localhost`, and never changes anything. With `@gerra/dashboard` installed next to `@gerra/cli`, `gerra dashboard` starts it too. Requires Node 24+.

https://github.com/bottercode/gerra · MIT
