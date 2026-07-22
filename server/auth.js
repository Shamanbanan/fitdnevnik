const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_COOKIE = "session_token";
const SESSION_DAYS = 30;
const INVITE_CODE = process.env.INVITE_CODE || "";

if (!INVITE_CODE) {
  console.warn("[auth] INVITE_CODE is not set — registration will reject everyone. Set it in the environment.");
}

const insertUser = db.prepare(
  "INSERT INTO users (username, password_hash) VALUES (?, ?)"
);
const findUserByUsername = db.prepare("SELECT * FROM users WHERE username = ?");
const findUserById = db.prepare("SELECT id, username FROM users WHERE id = ?");
const insertSession = db.prepare(
  "INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
);
const findSession = db.prepare(
  "SELECT * FROM auth_sessions WHERE token = ?"
);
const deleteSession = db.prepare("DELETE FROM auth_sessions WHERE token = ?");
const deleteExpiredSessions = db.prepare(
  "DELETE FROM auth_sessions WHERE expires_at < datetime('now')"
);

function isValidUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_.-]{3,32}$/.test(u);
}

function createSessionForUser(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  insertSession.run(token, userId, expiresAt);
  return { token, expiresAt };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    /* secure-cookie требует HTTPS — включай только когда сайт реально отдаётся по https,
       иначе браузер молча откажется сохранять cookie и логин перестанет работать */
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

function register(req, res) {
  const { username, password, inviteCode } = req.body || {};
  if (!INVITE_CODE || inviteCode !== INVITE_CODE) {
    return res.status(403).json({ error: "Неверный инвайт-код" });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Логин: 3-32 символа, латиница/цифры/._-" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Пароль должен быть не короче 8 символов" });
  }
  if (findUserByUsername.get(username)) {
    return res.status(409).json({ error: "Такой логин уже занят" });
  }
  const hash = bcrypt.hashSync(password, 12);
  const info = insertUser.run(username, hash);
  const { token } = createSessionForUser(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.json({ username });
}

function login(req, res) {
  const { username, password } = req.body || {};
  const user = typeof username === "string" ? findUserByUsername.get(username) : null;
  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  const { token } = createSessionForUser(user.id);
  setSessionCookie(res, token);
  res.json({ username: user.username });
}

function logout(req, res) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) deleteSession.run(token);
  clearSessionCookie(res);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: "Не авторизован" });
  const session = findSession.get(token);
  if (!session || new Date(session.expires_at) < new Date()) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Сессия истекла" });
  }
  const user = findUserById.get(session.user_id);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Не авторизован" });
  }
  req.user = user;
  next();
}

function me(req, res) {
  res.json({ username: req.user.username });
}

/* раз в час подчищаем протухшие сессии, чтобы таблица не росла бесконечно */
setInterval(() => {
  try { deleteExpiredSessions.run(); } catch (e) { /* noop */ }
}, 60 * 60 * 1000).unref();

module.exports = { register, login, logout, requireAuth, me };
