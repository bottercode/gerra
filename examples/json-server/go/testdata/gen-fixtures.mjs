// Records what Node/V8 does for the JavaScript behavior the Go port re-implements, so `go test`
// can check the port against the real thing. Run: node testdata/gen-fixtures.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const jsonServer = require.resolve("json-server/package.json", { paths: [join(import.meta.dirname, "../..")] });
const inflection = createRequire(jsonServer)("inflection");

const parseErrors = [
  "", " ", "x", "not json", "{bad", "{", "[", "[1,]", "[1 2]", "{\"a\" 1}", "{\"a\":1,}", "{\"a\":1 \"b\":2}",
  "{'a':1}", "\"abc", "\"a\u0001\"", "\"\\x\"", "\"\\u12G4\"", "-", "-a", "1.", "1.e5", "1e", "1e+", "01", "[01]",
  "tru", "trux", "nul", "nulx", "fals", "{\"a\":tru}", "undefined", "NaN", "Infinity", "[object Object]",
  "{\"title\": \"hello\", \"views\": 12,}", "{\"title\": \"hello\", \"views\": 12, oops}",
  "this string is definitely longer than twenty-one characters", "{\"a\":1}\n{\"b\":2}", "[1,\n2,\n x]",
  "{\"name\": \"Zoë\", x}", "{\"emoji\": \"😀\" x}", "1 2", "\"a\" \"b\"", "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, x]",
  "{\"a\":\"b\"}x", "[\"a\" \"b\"]", "{\"a\":1}}", "[]]", "nulll",
];
const numbers = [0, -0, 1, -1, 0.1, 0.5, 1.5, 4.5, 100, 1e21, 1e20, 123456789012345680000, 1.5e-7, 0.000001, 0.0000001,
  1 / 3, 2 / 3, 59.5, 91.73, 9.41, 1e300, -1e-300, 5e-324, 1.7976931348623157e308, 123.456, 9007199254740993, 0.1 + 0.2, 2 ** 53];
const numberStrings = ["", " ", "12", " 12 ", "1e3", "1.", ".5", "-.5", "+3", "0x1F", "0b101", "0o17", "-0x10", "Infinity",
  "-Infinity", "1_000", "12px", "1e", "\u00a012\u2003", "NaN", "00012", "1e400", "-0", "3.14", ".", "e5", "0x", "true"];
const words = ["apple", "Apple", "APPLE", "banana", "Banana", "édition", "edition", "Edition", "zebra", "Zebra", "Zoë", "zoe",
  "Ívar", "ivar", "API", "api", "a b", "a-b", "ab", "a_b", "a.b", "10", "9", "1", "_x", "-x", " x", "x", "ß", "ss", "æ", "ae",
  "ø", "o", "über", "uber", "Ubér", "naïve", "naive", "日本", "中文", "😀", "a😀", "", "Hello World", "hello world", "hello-world"];
const nouns = ["post", "posts", "comment", "comments", "user", "users", "profile", "person", "people", "category", "categories",
  "status", "statuses", "child", "children", "datum", "data", "news", "series", "analysis", "analyses", "box", "boxes", "quiz",
  "quizzes", "mouse", "mice", "ox", "oxen", "matrix", "matrices", "index", "indices", "wife", "wives", "leaf", "leaves", "tag",
  "tags", "Photo", "Photos", "bus", "buses", "address", "addresses", "equipment", "sheep", "fish", "todo", "todos", ""];

const fixtures = {
  parseErrors: parseErrors.map((input) => {
    try {
      JSON.parse(input);
      return { input, error: null };
    } catch (e) {
      return { input, error: e.message };
    }
  }),
  numbers: numbers.map((n) => ({ bits: Buffer.from(new Float64Array([n]).buffer).toString("hex"), string: String(n) })),
  numberStrings: numberStrings.map((s) => ({ input: s, number: String(Number(s)) })),
  sortedWords: [...words].sort((a, b) => a.localeCompare(b)),
  inflection: nouns.map((w) => ({ word: w, plural: inflection.pluralize(w), singular: inflection.singularize(w) })),
};
writeFileSync(join(import.meta.dirname, "js-fixtures.json"), JSON.stringify(fixtures, null, 2) + "\n");
console.log(`testdata/js-fixtures.json from Node ${process.version} (${Intl.DateTimeFormat().resolvedOptions().locale})`);
