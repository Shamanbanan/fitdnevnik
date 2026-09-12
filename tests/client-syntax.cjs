const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g), match => match[1]);

assert.ok(scripts.length > 0, "index.html must contain an inline application script");
scripts.forEach(script => new vm.Script(script));

console.log(`PASS: ${scripts.length} inline script(s) compile successfully`);
