// Writes data/db.json (for json-server) and data/db-go.json (for the Go port): the same deterministic
// blog dataset, in json-server's documented shape. Both servers write changes back to their file, so
// re-run this before replaying a tape that writes.
import { mkdirSync, writeFileSync } from "node:fs";

let s = 42;
const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const words = ["go", "node", "rust", "Proxy", "cache", "latency", "édition", "API", "json", "Zebra", "apple", "Banana", "http", "test", "replay", "shadow"];
const tags = ["news", "howto", "release", "opinion", "deep-dive"];
const names = ["Ada", "alan", "Grace", "linus", "Margaret", "ken", "Barbara", "dennis", "Zoë", "Ívar"];

const users = names.map((name, i) => ({
  id: String(i + 1),
  name,
  email: `${name.toLowerCase()}@example.test`,
  admin: i % 4 === 0,
  address: { city: pick(["Lisbon", "Oslo", "Austin", "Pune", "Kyoto"]), zip: String(int(10000, 99999)) },
}));

const posts = Array.from({ length: 400 }, (_, i) => {
  const post = {
    id: String(i + 1),
    title: `${pick(words)} ${pick(words)} ${pick(words)}`,
    views: int(0, 5000),
    rating: Math.round(rand() * 50) / 10,
    published: rand() > 0.3,
    tags: [pick(tags), pick(tags)],
    userId: String(int(1, users.length)),
  };
  if (i % 9 === 0) post.subtitle = null; // null vs missing
  if (i % 13 === 0) delete post.rating; // some posts lack a field (sorting puts them last)
  return post;
});

const comments = Array.from({ length: 1600 }, (_, i) => ({
  id: String(i + 1),
  text: `${pick(words)} ${pick(words)}`,
  postId: String(int(1, posts.length)),
  userId: String(int(1, users.length)),
  likes: int(0, 40),
}));

const db = { posts, comments, users, profile: { name: "typicode", theme: "dark", followers: 1200 } };
mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
const text = JSON.stringify(db, null, 2) + "\n";
writeFileSync(new URL("./data/db.json", import.meta.url), text);
writeFileSync(new URL("./data/db-go.json", import.meta.url), text);
console.log(`data/db.json, data/db-go.json: ${posts.length} posts, ${comments.length} comments, ${users.length} users, profile`);
