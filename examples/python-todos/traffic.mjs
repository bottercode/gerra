// Sends a day of todo traffic through the recorder: reads, creates, edits, completions and deletes, in
// an order where later reads depend on earlier writes.  node traffic.mjs http://localhost:8200
const base = process.argv[2] ?? "http://localhost:8200";

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  await res.arrayBuffer();
  return res.status;
}

const steps = [
  ["GET", "/todos"],
  ["GET", "/stats"],
  ["GET", "/todos/2"],
  ["GET", "/todos/99"],
  ["GET", "/todos?done=true"],
  ["POST", "/todos", { title: "  Pick up the dry cleaning " }],
  ["POST", "/todos", { title: "" }],
  ["POST", "/todos", "not json"],
  ["GET", "/todos/9"],
  ["PATCH", "/todos/2", { done: true }],
  ["GET", "/stats"],
  ["PATCH", "/todos/2", { done: true }],
  ["PATCH", "/todos/3", { title: "Call the dentist (Tuesday)" }],
  ["PATCH", "/todos/4", { done: "yes" }],
  ["PATCH", "/todos/5", { done: true }],
  ["GET", "/stats"],
  ["DELETE", "/todos/6"],
  ["DELETE", "/todos/6"],
  ["GET", "/stats"],
  ["PATCH", "/todos/9", { done: true }],
  ["PATCH", "/todos/7", { done: true }],
  ["GET", "/todos?done=false"],
  ["GET", "/stats"],
  ["GET", "/todos/"],
  ["GET", "/todos"],
];

let n = 0;
for (const [method, path, body] of steps) {
  const status = await call(method, path, body);
  console.log(`${method.padEnd(6)} ${path.padEnd(18)} ${status}`);
  n++;
}
console.log(`${n} requests`);
