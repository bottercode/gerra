// A small pricing API to record against. Run: pnpm --filter @gerra/example-express-pricing start
// Deliberately includes the things a rewrite tends to get subtly wrong:
//   - float money math with JS rounding (Math.round rounds .5 up, toward +∞)
//   - per-request noise that diffing must ignore: quoteId (UUID) and generatedAt (ISO time) are caught by
//     gerra's normalizers; validUntil (epoch ms) is only caught by learning noise from the original
//   - auth headers and PII (email) that recording must mask
import { randomUUID } from "node:crypto";
import express from "express";

const PRODUCTS = [
  { id: 1, name: "Espresso beans 1kg", category: "coffee", price: 24.99 },
  { id: 2, name: "Pour-over kettle", category: "gear", price: 59.5 },
  { id: 3, name: "Paper filters (100)", category: "gear", price: 6.15 },
  { id: 4, name: "Decaf beans 500g", category: "coffee", price: 13.45 },
];

const COUPONS = { WELCOME10: { percent: 10 }, FIVEOFF: { flat: 5 } };
const TAX_RATE = 0.0825;
const QUOTE_TTL_MS = 15 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/products", (req, res) => {
  const { category } = req.query;
  res.json(category ? PRODUCTS.filter((p) => p.category === category) : PRODUCTS);
});

app.get("/products/:id", (req, res) => {
  const product = PRODUCTS.find((p) => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: "product not found" });
  res.json(product);
});

app.post("/cart/price", (req, res) => {
  const { items, coupon } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items must be a non-empty array" });
  }
  const lines = [];
  for (const { productId, qty } of items) {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return res.status(422).json({ error: `unknown product ${productId}` });
    if (!Number.isInteger(qty) || qty < 1) return res.status(422).json({ error: `bad qty for product ${productId}` });
    lines.push({ productId, name: product.name, qty, unitPrice: product.price, lineTotal: round2(product.price * qty) });
  }
  const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const c = coupon ? COUPONS[coupon] : undefined;
  if (coupon && !c) return res.status(422).json({ error: `unknown coupon ${coupon}` });
  const discount = c ? round2(c.percent ? (subtotal * c.percent) / 100 : Math.min(c.flat, subtotal)) : 0;
  const tax = round2((subtotal - discount) * TAX_RATE);
  res.json({
    quoteId: randomUUID(),
    generatedAt: new Date().toISOString(),
    validUntil: Date.now() + QUOTE_TTL_MS,
    lines,
    subtotal,
    discount,
    tax,
    total: round2(subtotal - discount + tax),
  });
});

// Pretend auth: any bearer token works; the response includes PII.
app.get("/me", (req, res) => {
  const auth = req.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "missing bearer token" });
  res.json({ id: 42, name: "Ada Lovelace", email: "ada@example.com", plan: "pro" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`express-pricing listening on http://localhost:${port}`));
