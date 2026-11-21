# Launch video

`gerra-launch.mp4` (1920×1080, 22.5 s loop, for X) and `gerra-launch.gif` (960 px, for GitHub) show a replay of the json-server demo: one route differs (`OPTIONS /posts`, `content-length: "0" → (none)`), the fix lands, and all 2000 recorded requests match. The numbers and the difference come from the real Go port (`examples/json-server`).

The style follows the open-source CLI launches that did best on X: one command typed large, a short loop that turns from red to green, one caption at a time, no intro or end card, no music (X autoplays muted).

`index.html` draws any frame from `render(t)`. To re-render, with Google Chrome installed:

```bash
node capture.mjs 30 22.5 frames            # 450 PNG frames from a throwaway headless Chrome
ffmpeg -framerate 30 -i frames/f%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart gerra-launch.mp4
```

## Real run (`gerra-real-run.mp4`)

One unedited terminal session, 49 s: json-server is cloned from GitHub at `v1.0.0-beta.15` and started from its own source, `@gerra/cli` is installed from npm, 2000 requests (`examples/json-server/traffic.mjs reads`) are recorded through it, and the tape is replayed against the Go port: 2000 of 2000 identical. Recorded with [vhs](https://github.com/charmbracelet/vhs) from `real-run.tape`; only the dependency install and two `clear`s happen off camera.
