import type { Exchange } from "./tape.js";

const ID_SEGMENT = [
  /^\d+$/, // numeric ids
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUIDs
  /^[0-9a-f]{24,}$/i, // long hex (Mongo ObjectIds, hashes)
];

/**
 * Group key for an exchange: method plus path with id-like segments collapsed to `:id`.
 * `GET /products/42?x=1` → `GET /products/:id`.
 */
export function routeOf(method: string, path: string): string {
  const normalized = path
    .split("/")
    .map((seg) => (seg !== "" && ID_SEGMENT.some((re) => re.test(seg)) ? ":id" : seg))
    .join("/");
  return `${method.toUpperCase()} ${normalized || "/"}`;
}

export interface RouteSummary {
  route: string;
  count: number;
  /** Response status → number of exchanges, e.g. `{ "200": 10, "404": 2 }`. */
  statuses: Record<string, number>;
}

/** Count exchanges per route, most frequent first (ties broken alphabetically). */
export function summarizeRoutes(exchanges: readonly Exchange[]): RouteSummary[] {
  const byRoute = new Map<string, RouteSummary>();
  for (const ex of exchanges) {
    const route = routeOf(ex.request.method, ex.request.path);
    let entry = byRoute.get(route);
    if (!entry) {
      entry = { route, count: 0, statuses: {} };
      byRoute.set(route, entry);
    }
    entry.count++;
    const status = String(ex.response.status);
    entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
  }
  return [...byRoute.values()].sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
}

/**
 * Whether a request belongs to a route filter. Filters are written like `gerra tapes` shows routes:
 * `POST /cart/price`, `GET /products/:id` (any id), `GET /products/42` (same as `:id`), or just a path
 * (`/cart/price`) for every method. Methods are case-insensitive.
 */
export function matchesRoute(filter: string, method: string, path: string): boolean {
  const f = filter.trim().replace(/\s+/g, " ");
  const [first = "", ...rest] = f.split(" ");
  const filterMethod = f.startsWith("/") ? null : first.toUpperCase();
  const filterPath = f.startsWith("/") ? f : rest.join(" ");
  if (!filterPath.startsWith("/")) return false;
  if (filterMethod !== null && filterMethod !== method.toUpperCase()) return false;
  const pathOf = (route: string) => route.slice(route.indexOf(" ") + 1);
  return pathOf(routeOf("X", filterPath)) === pathOf(routeOf("X", path));
}
