// A "rewrite" of server.js, the kind an AI port might produce: no Express, plain node:http, and money
// math in integer cents instead of floats. It looks equivalent, and mostly is. Replay the tape you
// recorded from server.js against it and gerra shows where it isn't:
//   - a 10% coupon on a subtotal ending in 5 cents rounds the other way (cents round half up exactly,
//     floats like 9.415 are really 9.41499… and round down)
//   - per-request quoteId/generatedAt/validUntil differ on every call; that's noise, not a bug, and
//     gerra filters it (normalizers, plus noise learned with --original)
// Run: PORT=4000 node rewrite.js
import { randomUUID } from "node:crypto";
import http from "node:http";

const PRODUCTS = [
  { id: 1, name: "Espresso beans 1kg", category: "coffee", cents: 2499 },
  { id: 2, name: "Pour-over kettle", category: "gear", cents: 5950 },
  { id: 3, name: "Paper filters (100)", category: "gear", cents: 615 },
  { id: 4, name: "Decaf beans 500g", category: "coffee", cents: 1345 },
];
const COUPONS = { WELCOME10: { percent: 10 }, FIVEOFF: { flatCents: 500 } };
const TAX_BASIS_POINTS = 825; // 8.25%

const toDollars = (cents) => cents / 100;
const publicProduct = ({ cents, ...p }) => ({ ...p, price: toDollars(cents) });

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function priceCart(body) {
  const { items, coupon } = body ?? {};
  if (!Array.isArray(items) || items.length === 0) return [400, { error: "items must be a non-empty array" }];
  const lines = [];
  for (const { productId, qty } of items) {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return [422, { error: `unknown product ${productId}` }];
    if (!Number.isInteger(qty) || qty < 1) return [422, { error: `bad qty for product ${productId}` }];
    lines.push({ productId, name: product.name, qty, unitCents: product.cents, totalCents: product.cents * qty });
  }
  const subtotal = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const c = coupon ? COUPONS[coupon] : undefined;
  if (coupon && !c) return [422, { error: `unknown coupon ${coupon}` }];
  const discount = c ? (c.percent ? Math.round((subtotal * c.percent) / 100) : Math.min(c.flatCents, subtotal)) : 0;
  const tax = Math.round(((subtotal - discount) * TAX_BASIS_POINTS) / 10000);
  return [
    200,
    {
      quoteId: randomUUID(),
      generatedAt: new Date().toISOString(),
      validUntil: Date.now() + 15 * 60 * 1000,
      lines: lines.map((l) => ({
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        unitPrice: toDollars(l.unitCents),
        lineTotal: toDollars(l.totalCents),
      })),
      subtotal: toDollars(subtotal),
      discount: toDollars(discount),
      tax: toDollars(tax),
      total: toDollars(subtotal - discount + tax),
    },
  ];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const route = `${req.method} ${url.pathname}`;
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (route === "GET /health") return send(res, 200, { ok: true });
    if (route === "GET /products") {
      const category = url.searchParams.get("category");
      return send(res, 200, PRODUCTS.filter((p) => !category || p.category === category).map(publicProduct));
    }
    const m = url.pathname.match(/^\/products\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const product = PRODUCTS.find((p) => p.id === Number(m[1]));
      return product ? send(res, 200, publicProduct(product)) : send(res, 404, { error: "product not found" });
    }
    if (route === "POST /cart/price") {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      const [status, result] = priceCart(body);
      return send(res, status, result);
    }
    if (route === "GET /me") {
      if (!(req.headers.authorization ?? "").startsWith("Bearer ")) return send(res, 401, { error: "missing bearer token" });
      return send(res, 200, { id: 42, name: "Ada Lovelace", email: "ada@example.com", plan: "pro" });
    }
    send(res, 404, { error: "not found" });
  });
});

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => console.log(`pricing rewrite listening on http://localhost:${port}`));
