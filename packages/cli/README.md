# @gerra/cli

**Rewrite your backend with AI, and prove nothing broke.**

gerra records how your existing service behaves on real traffic, replays that traffic against the rewritten version, shows you every difference, and then moves traffic over gradually with automatic rollback. It works at the HTTP layer, so the old and new services can be in any language.

```bash
npx @gerra/cli record  --target http://localhost:3000 --tape checkout      # watch the old service
npx @gerra/cli replay  checkout --against http://localhost:4000            # test the rewrite on real requests
npx @gerra/cli shadow  --primary :3000 --candidate :4000                   # compare on live traffic, users unaffected
npx @gerra/cli cutover --primary :3000 --candidate :4000 --hold 10m        # switch 1% → 10% → 50% → 100%, auto-rollback
```

Requires Node 24+. Every command has `--help`.

Docs, examples and the json-server → Go demo: https://github.com/bottercode/gerra

MIT
