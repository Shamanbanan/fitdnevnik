const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const db = require("./db");
const { register, login, logout, requireAuth, me, changeUsername, changePassword } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
// The production topology has exactly one reverse proxy (Caddy). Without this,
// every visitor shares the proxy IP and exhausts the same authentication limit.
app.set("trust proxy", 1);
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/api/auth/register", authLimiter, register);
app.post("/api/auth/login", authLimiter, login);
app.post("/api/auth/logout", logout);
app.get("/api/auth/me", requireAuth, me);
app.post("/api/auth/change-username", authLimiter, requireAuth, changeUsername);
app.post("/api/auth/change-password", authLimiter, requireAuth, changePassword);

const selectAllForUser = db.prepare("SELECT key, value FROM user_data WHERE user_id = ?");
const upsertData = db.prepare(`
  INSERT INTO user_data (user_id, key, value, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

app.get("/api/bootstrap", requireAuth, (req, res) => {
  const rows = selectAllForUser.all(req.user.id);
  const data = {};
  for (const row of rows) data[row.key] = row.value;
  res.json(data);
});

const KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

app.put("/api/data/:key", requireAuth, (req, res) => {
  const { key } = req.params;
  if (!KEY_PATTERN.test(key)) return res.status(400).json({ error: "Некорректный ключ" });
  const { value } = req.body || {};
  if (typeof value !== "string") return res.status(400).json({ error: "value должен быть строкой" });
  upsertData.run(req.user.id, key, value);
  res.json({ ok: true });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API-метод не найден" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Некорректный JSON" });
  }
  console.error("[server] request failed", error);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`dnevnik server listening on port ${PORT}`);
  });
}

module.exports = app;
