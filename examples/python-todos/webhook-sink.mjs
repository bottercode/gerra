// Stands in for the service that receives the todo.completed webhook: answers 202 to every POST.
import http from "node:http";

const port = Number(process.env.PORT ?? 9900);
http
  .createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(req.method === "POST" ? 202 : 405).end());
  })
  .listen(port, "127.0.0.1", () => console.log(`webhook sink on http://127.0.0.1:${port}`));
