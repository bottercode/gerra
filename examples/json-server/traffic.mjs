import http from "node:http";

// Sends realistic, deterministic traffic to a json-server (usually through `gerra record`).
//   node traffic.mjs reads  [base] [count]   read-only mix, 16 at a time
//   node traffic.mjs writes [base]           a fixed sequence of writes, one at a time (needs a fresh `pnpm seed`)
//   node traffic.mjs edges  [base]           odd but legal requests, one at a time (needs a fresh `pnpm seed`)
const [mode = "reads", base = "http://localhost:8080", countArg] = process.argv.slice(2);

let s = 7;
const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const words = ["go", "node", "rust", "proxy", "cache", "API", "json", "zebra", "édition", "ban"];

// What a frontend built on json-server asks for, weighted by how often it asks.
const reads = [
  [10, () => `/posts?_page=${int(1, 12)}&_per_page=${pick([10, 20, 25])}`],
  [6, () => `/posts?_sort=${pick(["-views", "views", "title", "-title", "rating", "-rating", "-published,title", "userId,-views"])}&_page=${int(1, 4)}&_per_page=10`],
  [10, () => `/posts/${int(1, 420)}`],
  [6, () => `/posts/${int(1, 400)}?_embed=${pick(["comments", "user", "comments&_embed=user"])}`],
  [5, () => `/posts?views_gt=${int(1000, 4900)}&_sort=-views`],
  [3, () => `/posts?views:lte=${int(10, 300)}`],
  [4, () => `/posts?title:contains=${encodeURIComponent(pick(words))}`],
  [2, () => `/posts?title:startsWith=${pick(words)}&_sort=title`],
  [3, () => `/posts?published=${pick(["true", "false"])}&_page=${int(1, 3)}&_per_page=20`],
  [2, () => `/posts?rating:gte=${pick([3, 4, 4.5])}&published=true&_sort=-rating,title`],
  [2, () => `/posts?userId=${int(1, 10)}`],
  [2, () => `/comments?postId=${int(1, 400)}`],
  [2, () => `/comments?likes:in=${int(0, 40)},${int(0, 40)}&_sort=-likes`],
  [2, () => `/comments?_page=${int(1, 80)}&_sort=likes,text`],
  [2, () => `/posts?_where=${encodeURIComponent(JSON.stringify({ or: [{ views: { lt: int(5, 50) } }, { title: { contains: pick(words) } }] }))}`],
  [1, () => `/users?address.city=${pick(["Lisbon", "Oslo", "Kyoto"])}`],
  [1, () => `/users?name:endsWith=${pick(["a", "s", "ë", "r"])}`],
  [2, () => `/users?_sort=name`],
  [2, () => `/users/${int(1, 12)}?_embed=posts`],
  [2, () => `/profile`],
  [1, () => `/`],
  [1, () => pick([`/nope`, `/posts/1/comments`, `/profile/1`, `/posts?_page=0`, `/posts?_page=x&_per_page=-3`, `/comments?_per_page=7&_page=999`])],
];
const total = reads.reduce((n, [w]) => n + w, 0);
function nextRead() {
  let r = rand() * total;
  for (const [w, make] of reads) if ((r -= w) < 0) return make();
  return reads[0][1]();
}

// fetch() adds "cache-control: no-cache" to conditional requests (the Fetch spec says so), which
// defeats them; these go through node:http instead.
function sendRaw(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function send(method, path, body, headers = {}) {
  if (headers["if-none-match"] && !headers["cache-control"]) return sendRaw(method, path, headers);
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res.status;
}

if (mode === "reads") {
  const count = Number(countArg ?? 2000);
  const queue = Array.from({ length: count }, () => {
    const r = rand();
    if (r < 0.02) return ["HEAD", nextRead()];
    if (r < 0.03) return ["OPTIONS", "/posts", undefined, { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type" }];
    return ["GET", nextRead()];
  });
  let done = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let job; (job = queue.shift()); ) {
      await send(...job);
      done++;
    }
  }));
  console.log(`sent ${done} read requests to ${base}`);
} else if (mode === "writes") {
  // Order matters (later requests see earlier writes), so these go one at a time.
  const steps = [
    ["POST", "/posts", { title: "Hello from the rewrite", views: 0, published: false, tags: [], userId: "2" }],
    ["POST", "/comments", { text: "first!", postId: "3", likes: 0 }],
    ["POST", "/posts", { id: "custom", title: "ids are always generated" }],
    ["POST", "/posts", [1, 2]],
    ["POST", "/posts", "not json"],
    ["POST", "/profile", { name: "nope" }],
    ["POST", "/nope", { a: 1 }],
    ["PATCH", "/posts/5", { views: 9999, published: true }],
    ["GET", "/posts/5"],
    ["PUT", "/posts/6", { title: "replaced", views: 1 }],
    ["GET", "/posts/6"],
    ["PATCH", "/posts/7", { id: "700", title: "id stays 7" }],
    ["PATCH", "/posts/99999", { title: "missing" }],
    ["PUT", "/posts/8", "[]"],
    ["PATCH", "/profile", { theme: "light", followers: 1201 }],
    ["PUT", "/profile", { name: "gerra" }],
    ["GET", "/profile"],
    ["DELETE", "/users/2"],
    ["GET", "/posts?_sort=userId&_per_page=5&_page=1"],
    ["GET", "/users/2?_embed=posts"],
    ["DELETE", "/posts/10?_dependent=comments"],
    ["GET", "/posts?_sort=-views&_page=1&_per_page=5"],
    ["DELETE", "/posts/10"],
    ["DELETE", "/profile"],
    ["DELETE", "/nope/1"],
    ["PUT", "/posts", { a: 1 }],
    ["POST", "/"],
    ["GET", "/"],
  ];
  for (const [method, path, body] of steps) console.log(method, path, await send(method, path, body));
} else if (mode === "edges") {
  // Requests real clients send now and then: conditional GETs, odd query strings, malformed input.
  const index = await fetch(base + "/");
  const etag = index.headers.get("etag");
  await index.arrayBuffer();
  const big = JSON.stringify({ title: "x".repeat(150_000) });
  const steps = [
    ["GET", "/", undefined, { "if-none-match": etag }],
    ["GET", "/", undefined, { "if-none-match": etag, "cache-control": "no-cache" }],
    ["GET", "/", undefined, { "if-none-match": '"something-else"' }],
    ["HEAD", "/"],
    ["GET", "/posts/"],
    ["GET", "/posts/1/"],
    ["GET", "//posts"],
    ["GET", "/%zz"],
    ["GET", "/posts/%E0%A4"],
    ["GET", "/po%73ts/%32"],
    ["GET", "/posts?_page=2?x=1&_per_page=3"],
    ["GET", "/posts?_per_page=5&views:gt=4990"],
    ["GET", "/posts?_page=1e3&_per_page=0&views:gt=4980"],
    ["GET", "/posts?views:gt=4990&views:lt=4999"],
    ["GET", "/posts?views=0x10"],
    ["GET", "/posts?id:in=1,2"],
    ["GET", "/posts?id=abc&_page=1"],
    ["GET", "/posts?tags[0]=news"],
    ["GET", "/posts?a[x]=1"],
    ["GET", "/posts?title:foo=x&_page=40&_per_page=10"],
    ["GET", "/posts?title:=api&_page=1"],
    ["GET", "/posts?rating:ne=null&views:lt=60"],
    ["GET", `/posts?_where=${encodeURIComponent("[1]")}`],
    ["GET", `/posts?_where=${encodeURIComponent("{bad")}&views:lt=30`],
    ["GET", `/posts?_where=${encodeURIComponent('{"views":{"gte":4995},"published":{"eq":true}}')}`],
    ["GET", `/posts?_where=${encodeURIComponent('{"or":[]}')}`],
    ["GET", "/posts?title:contains=%C3%89DITION&_sort=-views&_page=1&_per_page=4"],
    ["GET", "/posts?title:endsWith=+API&_sort=title,-id"],
    ["GET", "/posts?subtitle=null&_page=3&_per_page=5"],
    ["GET", "/comments?likes:in=&_page=1"],
    ["GET", "/comments?likes:in=0,%201,+2&_sort=-likes,id&_page=2&_per_page=7"],
    ["GET", "/users?_sort=address.city,-name"],
    ["GET", "/users?_sort=-admin,name"],
    ["GET", "/users?address.zip:startsWith=1"],
    ["GET", "/posts?_sort=-subtitle&_page=1&_per_page=5"],
    ["GET", "/posts?_sort=tags&_page=1&_per_page=5"],
    ["GET", "/posts/1?_embed=comments&_embed=comments"],
    ["GET", "/users/1?_embed=posts&_embed=comments"],
    ["GET", "/posts/3?_embed=user&_embed=nothing&_embed="],
    ["GET", "/comments?_embed=post&_page=1&_per_page=2"],
    ["GET", "/profile?_sort=name&_page=2"],
    ["GET", "/posts", undefined, { "access-control-request-headers": "x-one,X-Two , ,authorization" }],
    ["OPTIONS", "/"],
    ["OPTIONS", "/posts/1", undefined, { "access-control-request-headers": "" }],
    ["PURGE", "/posts"],
    ["PURGE", "/"],
    ["POST", "/posts", big],
    ["POST", "/posts", "  "],
    ["POST", "/posts", '{"title": "hello", "views": 12, oops}'],
    ["POST", "/posts", '{"title": "this body is long enough for context" x}'],
    ["POST", "/posts", "undefined"],
    ["POST", "/posts", '{"title":"from text/plain"}', { "content-type": "text/plain" }],
    ["POST", "/posts/1", { title: "POST to an item" }],
    ["PUT", "/profile", '"a string"'],
    ["PATCH", "/posts/1", "null"],
    ["PATCH", "/posts/1", { tags: ["edited"], "nested": { "a": [1, { "b": null }] }, "num": 1e21, "small": 1.5e-7, "esc": "tab\tquote\"" }],
    ["GET", "/posts/1"],
    ["DELETE", "/posts/3", "{bad"],
    ["DELETE", "/posts/4", "", { "content-type": "application/json" }],
    ["GET", "/comments?postId=4"],
  ];
  for (const [method, path, body, headers] of steps) console.log(method, path, await send(method, path, body, headers));
} else {
  console.error("usage: node traffic.mjs reads|writes|edges [base] [count]");
  process.exit(2);
}
