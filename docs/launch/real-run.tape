Output real-run.mp4

Set Shell "bash"
Set FontSize 26
Set Width 1920
Set Height 1080
Set Padding 36
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "source setup.sh"
Enter
Sleep 3s
Show

Type "# json-server: 75.8K stars on GitHub. Clone the real project:"
Enter
Type "git -c advice.detachedHead=false clone -q --depth 1 --branch v1.0.0-beta.15 https://github.com/typicode/json-server"
Enter
Wait@60s /\$$/
Type "cd json-server && npm install --ignore-scripts --silent"
Enter
Hide
Wait@180s /\$$/
Show
Sleep 500ms

Type "# Start it from its own source, with a sample database:"
Enter
Type "node src/bin.ts --port 3000 ../db-run.json > /dev/null &"
Enter
Sleep 2s

Type "# Install gerra and put it in front of json-server:"
Enter
Type "npm install --silent --prefix .. @gerra/cli"
Enter
Wait@60s /\$$/
Type "gerra record --target :3000 --tape jsonserver --quiet > record.log 2>&1 &"
Enter
Sleep 2s

Type "# Send 2000 realistic requests through it:"
Enter
Type "node ../traffic.mjs reads"
Enter
Wait@120s /\$$/
Type "kill -INT %gerra && sleep 2 && tail -1 record.log"
Enter
Wait@30s /\$$/
Sleep 2.5s
Hide
Type "stty sane; clear"
Enter
Sleep 500ms
Show
Type "# Every request and the exact answer json-server gave:"
Enter

Type "gerra tapes jsonserver"
Enter
Sleep 4s

Hide
Type "clear"
Enter
Show

Type "# The AI-written Go version runs on :4000. Replay the recorded traffic against it:"
Enter
Type "gerra replay jsonserver --against :4000 --config ../gerra.config.json"
Enter
Wait@120s /\$$/
Sleep 7s
