const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const start = html.indexOf("function createRemoteStorageShim(){");
const end = html.indexOf("const localStorage = createRemoteStorageShim();", start);
assert.ok(start >= 0 && end > start, "remote storage shim source must be present");

const browserStorage = new MemoryStorage({
  "dnevnik:cache:legacy": "legacy-alice",
  "dnevnik:pendingSync": JSON.stringify({ legacy: "legacy-alice" })
});
const context = vm.createContext({
  console,
  encodeURIComponent,
  fetch: async () => { throw new Error("offline"); },
  setInterval: () => 0,
  window: {
    localStorage: browserStorage,
    addEventListener: () => {}
  }
});

vm.runInContext(`
  let currentUsername = "alice";
  let usernameAtStartup = "alice";
  function debounce(fn){ return (...args)=>fn(...args); }
  ${html.slice(start, end)}
  const shim = createRemoteStorageShim();
  globalThis.testApi = {
    setUser: value => { currentUsername = value; },
    hasCache: () => shim._hasLocalCache(),
    hydrateLocal: () => shim._hydrateFromLocalCache(),
    hydrate: value => shim._hydrate(value),
    get: key => shim.getItem(key),
    set: (key, value) => shim.setItem(key, value),
    rename: (from, to) => shim._renameOwner(from, to)
  };
`, context);

const api = context.testApi;
assert.equal(api.hasCache(), true);
api.hydrateLocal();
assert.equal(api.get("legacy"), "legacy-alice", "legacy cache is migrated only to its recorded owner");

api.set("workout", "alice-value");
api.setUser("bob");
api.hydrate({});
assert.equal(api.get("workout"), null, "a second user cannot see the first user's memory cache");
assert.equal(api.get("legacy"), null, "a second user cannot see the first user's migrated cache");

api.set("workout", "bob-value");
api.setUser("alice");
api.hydrateLocal();
assert.equal(api.get("workout"), "alice-value");

api.rename("alice", "alice-renamed");
api.setUser("alice-renamed");
api.hydrateLocal();
assert.equal(api.get("workout"), "alice-value", "renaming an account preserves its offline cache");

api.setUser("bob");
api.hydrateLocal();
assert.equal(api.get("workout"), "bob-value");

console.log("PASS: offline cache and outbox are isolated by account and survive username changes");
