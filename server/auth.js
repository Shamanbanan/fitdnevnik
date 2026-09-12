const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_COOKIE = "session_token";
const SESSION_DAYS = 30;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const INVITE_CODE = process.env.INVITE_CODE || "";

if (!INVITE_CODE) {
  console.warn("[auth] INVITE_CODE is not set — registration will reject everyone. Set it in the environment.");
}

const insertUser = db.prepare(
  "INSERT INTO users (username, password_hash) VALUES (?, ?)"
);
const findUserByUsername = db.prepare("SELECT * FROM users WHERE username = ?");
const findUserById = db.prepare("SELECT id, username FROM users WHERE id = ?");
const findUserByIdFull = db.prepare("SELECT * FROM users WHERE id = ?");
const updateUsername = db.prepare("UPDATE users SET username = ? WHERE id = ?");
const updatePasswordHash = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
const deleteOtherSessions = db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token != ?");
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

function passwordValidationError(password, prefix = "Пароль") {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `${prefix} должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `${prefix} должен быть не длиннее ${MAX_PASSWORD_LENGTH} символов`;
  }
  return null;
}

function isUniqueConstraint(error) {
  return error && (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY");
}

function createSessionForUser(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  insertSession.run(token, userId, expiresAt);
  return { token, expiresAt };
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    /* secure-cookie требует HTTPS — включай только когда сайт реально отдаётся по https,
       иначе браузер молча откажется сохранять cookie и логин перестанет работать */
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

function clearSessionCookie(res) {
  const { maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
}

function register(req, res) {
  const { username, password, inviteCode } = req.body || {};
  if (!INVITE_CODE || inviteCode !== INVITE_CODE) {
    return res.status(403).json({ error: "Неверный инвайт-код" });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Логин: 3-32 символа, латиница/цифры/._-" });
  }
  const passwordError = passwordValidationError(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const hash = bcrypt.hashSync(password, 12);
  let info;
  try {
    info = insertUser.run(username, hash);
  } catch (error) {
    if (isUniqueConstraint(error)) return res.status(409).json({ error: "Такой логин уже занят" });
    throw error;
  }
  const { token } = createSessionForUser(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.json({ username });
}

function login(req, res) {
  const { username, password } = req.body || {};
  const user = typeof username === "string" ? findUserByUsername.get(username) : null;
  const passwordCanBeChecked = typeof password === "string" && password.length <= MAX_PASSWORD_LENGTH;
  if (!user || !passwordCanBeChecked || !bcrypt.compareSync(password, user.password_hash)) {
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
  const expiresAt = session ? Date.parse(session.expires_at) : NaN;
  if (!session || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    if (session) deleteSession.run(token);
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

function changeUsername(req, res) {
  const { newUsername, password } = req.body || {};
  const user = findUserByIdFull.get(req.user.id);
  const passwordCanBeChecked = typeof password === "string" && password.length <= MAX_PASSWORD_LENGTH;
  if (!user || !passwordCanBeChecked || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Неверный пароль" });
  }
  if (!isValidUsername(newUsername)) {
    return res.status(400).json({ error: "Логин: 3-32 символа, латиница/цифры/._-" });
  }
  if (newUsername === user.username) {
    return res.status(400).json({ error: "Это и есть текущий логин" });
  }
  try {
    updateUsername.run(newUsername, user.id);
  } catch (error) {
    if (isUniqueConstraint(error)) return res.status(409).json({ error: "Такой логин уже занят" });
    throw error;
  }
  res.json({ username: newUsername });
}

function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const user = findUserByIdFull.get(req.user.id);
  const passwordCanBeChecked = typeof currentPassword === "string" && currentPassword.length <= MAX_PASSWORD_LENGTH;
  if (!user || !passwordCanBeChecked || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: "Неверный текущий пароль" });
  }
  const passwordError = passwordValidationError(newPassword, "Новый пароль");
  if (passwordError) return res.status(400).json({ error: passwordError });
  const hash = bcrypt.hashSync(newPassword, 12);
  updatePasswordHash.run(hash, user.id);
  /* разлогиниваем остальные сессии этого юзера (другие устройства/браузеры) —
     текущую (по которой сейчас пришёл запрос) оставляем активной */
  const currentToken = req.cookies && req.cookies[SESSION_COOKIE];
  deleteOtherSessions.run(user.id, currentToken || "");
  res.json({ ok: true });
}

/* раз в час подчищаем протухшие сессии, чтобы таблица не росла бесконечно */
setInterval(() => {
  try { deleteExpiredSessions.run(); } catch (e) { /* noop */ }
}, 60 * 60 * 1000).unref();

module.exports = { register, login, logout, requireAuth, me, changeUsername, changePassword };
