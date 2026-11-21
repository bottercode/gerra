# express-pricing (example)

A tiny Express pricing API to try gerra against.

```bash
pnpm install
pnpm --filter @gerra/example-express-pricing start            # http://localhost:3000

# in another terminal, from the repo root
pnpm build
pnpm gerra record --target http://localhost:3000 --port 8080 --tape checkout --mask-field email

# in a third terminal, send traffic through the proxy
curl localhost:8080/products
curl localhost:8080/products/2
curl -X POST localhost:8080/cart/price -H 'content-type: application/json' \
  -d '{"items":[{"productId":1,"qty":2},{"productId":3,"qty":1}],"coupon":"WELCOME10"}'
curl localhost:8080/me -H 'authorization: Bearer abc'

# a cart where float and integer-cents rounding disagree
curl -X POST localhost:8080/cart/price -H 'content-type: application/json' \
  -d '{"items":[{"productId":4,"qty":7}],"coupon":"WELCOME10"}'

# Ctrl-C the recorder, then
pnpm gerra tapes
```

`rewrite.js` is a port of the same API to plain `node:http` with integer-cents money math, the kind of rewrite an AI might produce. Replay the tape against it:

```bash
pnpm --filter @gerra/example-express-pricing start:rewrite   # http://localhost:4000
pnpm gerra replay checkout --against :4000 --unsafe-methods "POST /cart/price" --header "authorization: Bearer test"

# with the original running too, gerra learns which fields are noise (here: validUntil)
pnpm gerra replay checkout --against :4000 --original :3000 --unsafe-methods "POST /cart/price" --header "authorization: Bearer test"
```

`gerra.config.json` in this folder masks `email` and opts `POST /cart/price` in to replay. Pass it with `--config examples/express-pricing/gerra.config.json` (or run gerra from this folder) and you can drop `--mask-field` and `--unsafe-methods`.

gerra reports that the 7× decaf cart's discount went from 9.41 to 9.42, so the total changes too. Float 9.415 is really 9.41499…, so the original rounds down, while integer cents round half up. `quoteId` and `generatedAt` are ignored by the UUID and timestamp normalizers, and `validUntil` (epoch ms) once noise has been learned from the original. Arguably the rewrite is *more* correct, but it gives customers different totals, and that's exactly the kind of change you want to decide on deliberately.

Routes (both servers): `GET /health`, `GET /products[?category=]`, `GET /products/:id`, `POST /cart/price`, `GET /me` (needs `Authorization: Bearer …`).

`/cart/price` returns a fresh `quoteId`, `generatedAt` and `validUntil` on every call. These are the noise fields gerra filters out.

## Shadow

```bash
pnpm gerra shadow --primary :3000 --candidate :4000 --port 8080 --config examples/express-pricing/gerra.config.json --noise checkout
curl -X POST localhost:8080/cart/price -H 'content-type: application/json' \
  -d '{"items":[{"productId":4,"qty":7}],"coupon":"WELCOME10"}'   # you get the original's 91.73
pnpm gerra shadow status                                            # shows the rewrite answered 91.72
```

The example config opts `POST /cart/price` in to mirroring. That's safe here because pricing doesn't write anything.

## Cutover

```bash
pnpm gerra cutover --primary :3000 --candidate :4000 --port 8080 --steps 10,50,100 --hold 30s \
  --config examples/express-pricing/gerra.config.json --noise checkout
```

Send traffic to `:8080`. As long as it only hits `/products`, the rewrite takes over 10% → 50% → 100%. When a 7× decaf cart comes through, the diff rate passes 1% and all traffic goes back to `server.js`. `pnpm gerra cutover status` shows why.
