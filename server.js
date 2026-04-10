const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "";
const VERIFICATION_HOURS = Number(process.env.EMAIL_VERIFICATION_HOURS || 24);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || "";
const STRIPE_PRICE_YEARLY = process.env.STRIPE_PRICE_YEARLY || "";
const STRIPE_CUSTOMER_PORTAL_RETURN_URL = process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL || `${APP_BASE_URL}/?view=billing`;
const STRIPE_CHECKOUT_SUCCESS_URL = process.env.STRIPE_CHECKOUT_SUCCESS_URL || `${APP_BASE_URL}/?billing=success`;
const STRIPE_CHECKOUT_CANCEL_URL = process.env.STRIPE_CHECKOUT_CANCEL_URL || `${APP_BASE_URL}/?billing=cancel`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_MFA_SECRET = process.env.ADMIN_MFA_SECRET || "";
const DB_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DB_DIR, "lotto_tracker.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");

let stripeClient = null;

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH, (error) => {
  if (error) {
    console.error("SQLite open error:", error.message);
  } else {
    console.log("SQLite connected:", DB_PATH);
  }
});

app.disable("x-powered-by");
app.use((req, res, next) => {
  if (req.path === "/api/stripe/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
    return;
  }

  express.json({ limit: "2mb" })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows || []);
    });
  });
}

async function addColumnIfMissing(tableName, columnName, definition) {
  const rows = await allQuery(`PRAGMA table_info(${tableName})`);
  const exists = rows.some((row) => row.name === columnName);
  if (!exists) {
    await runQuery(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function initDatabase() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT DEFAULT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT DEFAULT '',
      address_line1 TEXT DEFAULT '',
      city TEXT DEFAULT '',
      province TEXT DEFAULT '',
      postal_code TEXT DEFAULT '',
      country TEXT DEFAULT 'CA',
      payment_method_preference TEXT DEFAULT 'CARD',
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      plan TEXT NOT NULL DEFAULT 'FREE',
      stripe_customer_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await addColumnIfMissing("users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("users", "plan", "TEXT NOT NULL DEFAULT 'FREE'");
  await addColumnIfMissing("users", "stripe_customer_id", "TEXT DEFAULT NULL");
  await addColumnIfMissing("users", "plan_gifted", "INTEGER DEFAULT 0");
  await addColumnIfMissing("users", "username", "TEXT DEFAULT NULL");
  await addColumnIfMissing("users", "phone", "TEXT DEFAULT ''");
  await addColumnIfMissing("users", "address_line1", "TEXT DEFAULT ''");
  await addColumnIfMissing("users", "city", "TEXT DEFAULT ''");
  await addColumnIfMissing("users", "province", "TEXT DEFAULT ''");
  await addColumnIfMissing("users", "postal_code", "TEXT DEFAULT ''");
  await addColumnIfMissing("users", "country", "TEXT DEFAULT 'CA'");
  await addColumnIfMissing("users", "payment_method_preference", "TEXT DEFAULT 'CARD'");

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game TEXT NOT NULL,
      draw_date TEXT NOT NULL,
      numbers_json TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      winnings REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'MANUAL',
      ticket_number TEXT DEFAULT '',
      barcode_value TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await addColumnIfMissing("tickets", "source", "TEXT NOT NULL DEFAULT 'MANUAL'");
  await addColumnIfMissing("tickets", "ticket_number", "TEXT DEFAULT ''");
  await addColumnIfMissing("tickets", "barcode_value", "TEXT DEFAULT ''");

  await runQuery(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT DEFAULT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT DEFAULT '',
      address_line1 TEXT DEFAULT '',
      city TEXT DEFAULT '',
      province TEXT DEFAULT '',
      postal_code TEXT DEFAULT '',
      country TEXT DEFAULT 'CA',
      payment_method_preference TEXT DEFAULT 'CARD',
      password_hash TEXT NOT NULL,
      selected_plan TEXT NOT NULL DEFAULT 'FREE',
      billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY',
      stripe_customer_id TEXT DEFAULT NULL,
      checkout_url TEXT DEFAULT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await addColumnIfMissing("pending_registrations", "username", "TEXT DEFAULT NULL");
  await addColumnIfMissing("pending_registrations", "phone", "TEXT DEFAULT ''");
  await addColumnIfMissing("pending_registrations", "address_line1", "TEXT DEFAULT ''");
  await addColumnIfMissing("pending_registrations", "city", "TEXT DEFAULT ''");
  await addColumnIfMissing("pending_registrations", "province", "TEXT DEFAULT ''");
  await addColumnIfMissing("pending_registrations", "postal_code", "TEXT DEFAULT ''");
  await addColumnIfMissing("pending_registrations", "country", "TEXT DEFAULT 'CA'");
  await addColumnIfMissing("pending_registrations", "payment_method_preference", "TEXT DEFAULT 'CARD'");

  await runQuery(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      stripe_customer_id TEXT NOT NULL,
      stripe_subscription_id TEXT NOT NULL UNIQUE,
      stripe_price_id TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'PRO',
      billing_cycle TEXT NOT NULL,
      status TEXT NOT NULL,
      current_period_start TEXT DEFAULT NULL,
      current_period_end TEXT DEFAULT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER DEFAULT NULL,
      stripe_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await runQuery(`CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_tickets_draw_date ON tickets(draw_date)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id ON email_verification_tokens(user_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_email_tokens_token ON email_verification_tokens(token)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_pending_registrations_email ON pending_registrations(email)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_pending_registrations_token ON pending_registrations(token)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_payment_events_user_id ON payment_events(user_id)`);

  console.log("Database initialized.");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function normalizePhone(phone) {
  return String(phone || "").trim();
}

function normalizeAddress(value) {
  return String(value || "").trim();
}

function normalizeCountry(country) {
  const normalized = String(country || "").trim().toUpperCase();
  return normalized || "CA";
}

function normalizePaymentMethodPreference(value) {
  return String(value || "").trim().toUpperCase() === "PAYPAL" ? "PAYPAL" : "CARD";
}

function safeJsonParse(value, fallback = []) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizeNumbers(numbers) {
  if (!Array.isArray(numbers)) {
    return [];
  }

  return [...new Set(
    numbers
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0 && value <= 99)
  )].sort((a, b) => a - b);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username || "",
    email: user.email,
    phone: user.phone || "",
    addressLine1: user.address_line1 || "",
    city: user.city || "",
    province: user.province || "",
    postalCode: user.postal_code || "",
    country: user.country || "CA",
    paymentMethodPreference: user.payment_method_preference || "CARD",
    emailVerified: Boolean(user.email_verified),
    plan: user.plan || "FREE",
    stripeCustomerId: user.stripe_customer_id || null,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

function serializeTicket(row) {
  return {
    id: row.id,
    game: row.game,
    drawDate: row.draw_date,
    numbers: safeJsonParse(row.numbers_json, []),
    cost: Number(row.cost || 0),
    winnings: Number(row.winnings || 0),
    notes: row.notes || "",
    source: row.source || "MANUAL",
    ticketNumber: row.ticket_number || "",
    barcodeValue: row.barcode_value || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getVerificationExpiry() {
  return new Date(Date.now() + VERIFICATION_HOURS * 60 * 60 * 1000).toISOString();
}

function stripeConfigured() {
  return Boolean(STRIPE_SECRET_KEY);
}

function stripeCheckoutConfigured() {
  return Boolean(stripeConfigured() && STRIPE_PRICE_MONTHLY && STRIPE_PRICE_YEARLY);
}

function canSendEmail() {
  return Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);
}

function getStripeClient() {
  if (!stripeConfigured()) {
    throw new Error("Stripe non configure.");
  }

  if (!stripeClient) {
    const Stripe = require("stripe");
    stripeClient = new Stripe(STRIPE_SECRET_KEY);
  }

  return stripeClient;
}

function billingCycleFromPrice(priceId) {
  if (priceId === STRIPE_PRICE_YEARLY) {
    return "YEARLY";
  }
  return "MONTHLY";
}

function activePlanFromStatus(status) {
  return ["active", "trialing"].includes(String(status || "").toLowerCase()) ? "PRO" : "FREE";
}

async function createVerificationToken(userId) {
  const token = generateVerificationToken();
  const now = new Date().toISOString();
  const expiresAt = getVerificationExpiry();

  await runQuery(
    `
      INSERT INTO email_verification_tokens (user_id, token, expires_at, created_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `,
    [userId, token, expiresAt, now]
  );

  return { token, expiresAt };
}

function buildVerificationUrl(token) {
  return `${APP_BASE_URL}/?verify=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail({ email, name, verifyUrl }) {
  if (!canSendEmail()) {
    return { sent: false, previewOnly: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [email],
      subject: "Confirme ton compte LottoTracker",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
          <h2>Bienvenue sur LottoTracker</h2>
          <p>Bonjour ${name},</p>
          <p>Confirme ton adresse courriel pour activer ton compte.</p>
          <p><a href="${verifyUrl}" style="display:inline-block;padding:12px 18px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;">Confirmer mon courriel</a></p>
          <p>Si le bouton ne fonctionne pas, copie ce lien dans ton navigateur :</p>
          <p>${verifyUrl}</p>
        </div>
      `
    })
  });

  if (!response.ok) {
    const text = await response.text();
    let parsed = null;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = null;
    }

    if (
      response.status === 403 &&
      parsed?.name === "validation_error"
    ) {
      const resendError = new Error(
        "L'envoi du courriel de confirmation a echoue. Verifie que ton adresse est valide et reessaie."
      );
      resendError.code = "RESEND_SEND_FAILED";
      throw resendError;
    }

    throw new Error(`Resend error: ${response.status} ${text}`);
  }

  return { sent: true, previewOnly: false };
}

async function issueVerificationForUser(user) {
  await runQuery(
    `UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
    [new Date().toISOString(), user.id]
  );

  const tokenData = await createVerificationToken(user.id);
  const verifyUrl = buildVerificationUrl(tokenData.token);
  const emailResult = await sendVerificationEmail({
    email: user.email,
    name: user.name,
    verifyUrl
  });

  return { verifyUrl, emailResult };
}

async function createOrReplacePendingRegistration({
  name,
  username = null,
  email,
  phone = "",
  addressLine1 = "",
  city = "",
  province = "",
  postalCode = "",
  country = "CA",
  paymentMethodPreference = "CARD",
  passwordHash,
  selectedPlan,
  billingCycle,
  stripeCustomerId = null,
  checkoutUrl = null
}) {
  const now = new Date().toISOString();
  const token = generateVerificationToken();
  const expiresAt = getVerificationExpiry();

  await runQuery(`DELETE FROM pending_registrations WHERE email = ?`, [email]);

  const result = await runQuery(
    `
      INSERT INTO pending_registrations (
        name, username, email, phone, address_line1, city, province, postal_code, country, payment_method_preference,
        password_hash, selected_plan, billing_cycle, stripe_customer_id, checkout_url, token, expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      name,
      username,
      email,
      phone,
      addressLine1,
      city,
      province,
      postalCode,
      country,
      paymentMethodPreference,
      passwordHash,
      selectedPlan,
      billingCycle,
      stripeCustomerId,
      checkoutUrl,
      token,
      expiresAt,
      now,
      now
    ]
  );

  return getQuery(`SELECT * FROM pending_registrations WHERE id = ?`, [result.lastID]);
}

async function issueVerificationForPending(pending) {
  const verifyUrl = buildVerificationUrl(pending.token);
  let emailResult = { sent: false };
  try {
    emailResult = await sendVerificationEmail({
      email: pending.email,
      name: pending.name,
      verifyUrl
    });
  } catch (emailError) {
    console.error("Email verification send error (non-blocking):", emailError.message);
  }
  return { verifyUrl, emailResult };
}

async function getLatestSubscriptionForUser(userId) {
  return getQuery(
    `
      SELECT *
      FROM subscriptions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [userId]
  );
}

function serializeSubscription(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    plan: row.plan,
    billingCycle: row.billing_cycle,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getEffectivePlan(userId) {
  const user = await getQuery(`SELECT plan_gifted FROM users WHERE id = ?`, [userId]);
  if (user && user.plan_gifted) return "PRO";
  const subscription = await getLatestSubscriptionForUser(userId);
  if (subscription && activePlanFromStatus(subscription.status) === "PRO") return "PRO";
  return "FREE";
}

async function ensureUserPlanCache(userId) {
  const plan = await getEffectivePlan(userId);
  await runQuery(`UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`, [plan, new Date().toISOString(), userId]);
  return plan;
}

async function getBillingStatusForUser(user) {
  const subscription = await getLatestSubscriptionForUser(user.id);
  const plan = await ensureUserPlanCache(user.id);
  const freshUser = await getQuery(`SELECT * FROM users WHERE id = ?`, [user.id]);

  return {
    plan,
    user: sanitizeUser(freshUser),
    stripeConfigured: stripeCheckoutConfigured(),
    prices: {
      monthly: STRIPE_PRICE_MONTHLY || null,
      yearly: STRIPE_PRICE_YEARLY || null
    },
    subscription: serializeSubscription(subscription)
  };
}

async function findUserByStripeCustomerId(customerId) {
  return getQuery(`SELECT * FROM users WHERE stripe_customer_id = ?`, [customerId]);
}

async function upsertSubscriptionRecord({ userId, customerId, subscriptionId, priceId, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd }) {
  const now = new Date().toISOString();
  const billingCycle = billingCycleFromPrice(priceId);
  const existing = await getQuery(`SELECT id FROM subscriptions WHERE stripe_subscription_id = ?`, [subscriptionId]);

  if (existing) {
    await runQuery(
      `
        UPDATE subscriptions
        SET stripe_customer_id = ?, stripe_price_id = ?, billing_cycle = ?, status = ?, current_period_start = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ?
        WHERE stripe_subscription_id = ?
      `,
      [customerId, priceId, billingCycle, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, now, subscriptionId]
    );
  } else {
    await runQuery(
      `
        INSERT INTO subscriptions (
          user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan, billing_cycle, status,
          current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'PRO', ?, ?, ?, ?, ?, ?, ?)
      `,
      [userId, customerId, subscriptionId, priceId, billingCycle, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, now, now]
    );
  }

  await runQuery(
    `UPDATE users SET stripe_customer_id = ?, plan = ?, updated_at = ? WHERE id = ?`,
    [customerId, activePlanFromStatus(status), now, userId]
  );
}

async function recordStripeEvent(event, userId = null) {
  try {
    await runQuery(
      `
        INSERT INTO payment_events (user_id, stripe_event_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [userId, event.id, event.type, JSON.stringify(event), new Date().toISOString()]
    );
  } catch (error) {
    if (!String(error.message || "").includes("UNIQUE")) {
      throw error;
    }
  }
}

async function activatePendingAsProUser(customerId) {
  const pending = await getQuery(`SELECT * FROM pending_registrations WHERE stripe_customer_id = ?`, [customerId]);
  if (!pending) {
    return null;
  }

  const existingUser = await getQuery(`SELECT * FROM users WHERE email = ?`, [pending.email]);
  if (existingUser) {
    await runQuery(`DELETE FROM pending_registrations WHERE id = ?`, [pending.id]);
    return existingUser;
  }

  const now = new Date().toISOString();
  const result = await runQuery(
    `
      INSERT INTO users (
        name, username, email, phone, address_line1, city, province, postal_code, country, payment_method_preference,
        password_hash, email_verified, plan, stripe_customer_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'PRO', ?, ?, ?)
    `,
    [
      pending.name,
      pending.username,
      pending.email,
      pending.phone,
      pending.address_line1,
      pending.city,
      pending.province,
      pending.postal_code,
      pending.country,
      pending.payment_method_preference,
      pending.password_hash,
      customerId,
      now,
      now
    ]
  );

  const newUser = await getQuery(`SELECT * FROM users WHERE id = ?`, [result.lastID]);
  await runQuery(`DELETE FROM pending_registrations WHERE id = ?`, [pending.id]);

  try {
    await issueVerificationForUser(newUser);
  } catch (emailError) {
    console.error("Email verification send error (non-blocking):", emailError.message);
  }

  return newUser;
}

async function syncStripeSubscription(subscription, fallbackUserId = null) {
  const customerId = String(subscription.customer || "");
  let user = customerId ? await findUserByStripeCustomerId(customerId) : null;

  if (!user && fallbackUserId) {
    user = await getQuery(`SELECT * FROM users WHERE id = ?`, [fallbackUserId]);
  }

  if (!user && customerId) {
    user = await activatePendingAsProUser(customerId);
  }

  if (!user) {
    throw new Error("Utilisateur Stripe introuvable.");
  }

  if (customerId && user.stripe_customer_id !== customerId) {
    await runQuery(`UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`, [customerId, new Date().toISOString(), user.id]);
  }

  const priceId = subscription.items?.data?.[0]?.price?.id || "";
  const currentPeriodStart = subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null;
  const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;

  await upsertSubscriptionRecord({
    userId: user.id,
    customerId,
    subscriptionId: subscription.id,
    priceId,
    status: subscription.status,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
  });

  await ensureUserPlanCache(user.id);
  return user;
}

// TOTP (RFC 6238) sans dépendance externe
function base32Decode(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  str = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const output = [];
  for (const char of str) {
    const idx = chars.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

function verifyTOTP(secret, token) {
  const timeStep = Math.floor(Date.now() / 1000 / 30);
  for (const delta of [-1, 0, 1]) {
    const key = base32Decode(secret);
    const step = timeStep + delta;
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
    buf.writeUInt32BE(step >>> 0, 4);
    const hmac = crypto.createHmac("sha1", key);
    hmac.update(buf);
    const digest = hmac.digest();
    const offset = digest[19] & 0xf;
    const code = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
    if (String(code % 1000000).padStart(6, "0") === String(token).trim()) return true;
  }
  return false;
}

function signAdminToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET + ":admin", { expiresIn: "8h" });
}

async function adminAuthMiddleware(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const [scheme, token] = auth.split(" ");
    if (scheme !== "Bearer" || !token) { res.status(401).json({ ok: false, message: "Admin non autorisé." }); return; }
    jwt.verify(token, JWT_SECRET + ":admin");
    next();
  } catch (error) {
    res.status(401).json({ ok: false, message: "Session admin invalide ou expirée." });
  }
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      res.status(401).json({ ok: false, message: "Acces non autorise." });
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await getQuery(`SELECT * FROM users WHERE id = ?`, [decoded.userId]);

    if (!user) {
      res.status(401).json({ ok: false, message: "Utilisateur introuvable." });
      return;
    }

    if (!user.email_verified) {
      res.status(403).json({
        ok: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Confirme ton courriel avant d'utiliser l'application."
      });
      return;
    }

    user.plan = await ensureUserPlanCache(user.id);
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ ok: false, message: "Session invalide ou expiree." });
  }
}

async function buildSummaryForUser(userId) {
  const rows = await allQuery(`SELECT game, cost, winnings, numbers_json FROM tickets WHERE user_id = ?`, [userId]);
  const totalTickets = rows.length;
  const totalSpent = rows.reduce((sum, row) => sum + Number(row.cost || 0), 0);
  const totalWon = rows.reduce((sum, row) => sum + Number(row.winnings || 0), 0);
  const netResult = totalWon - totalSpent;
  const topNumbersMap = {};
  const gamesMap = {};

  rows.forEach((row) => {
    safeJsonParse(row.numbers_json, []).forEach((number) => {
      topNumbersMap[number] = (topNumbersMap[number] || 0) + 1;
    });

    const gameName = row.game || "Autre";
    gamesMap[gameName] = (gamesMap[gameName] || 0) + 1;
  });

  const topNumbers = Object.entries(topNumbersMap)
    .map(([number, count]) => ({ number: Number(number), count: Number(count) }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.number - b.number))
    .slice(0, 10);

  const games = Object.entries(gamesMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { totalTickets, totalSpent, totalWon, netResult, topNumbers, games };
}

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    app: "LottoTracker Unified",
    time: new Date().toISOString(),
    emailProviderConfigured: canSendEmail(),
    stripeConfigured: stripeCheckoutConfigured()
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const username = normalizeUsername(req.body.username);
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const addressLine1 = normalizeAddress(req.body.addressLine1);
    const city = normalizeAddress(req.body.city);
    const province = normalizeAddress(req.body.province);
    const postalCode = normalizeAddress(req.body.postalCode);
    const country = normalizeCountry(req.body.country);
    const paymentMethodPreference = normalizePaymentMethodPreference(req.body.paymentMethodPreference);
    const password = String(req.body.password || "");
    const selectedPlan = String(req.body.selectedPlan || "FREE").trim().toUpperCase() === "PRO" ? "PRO" : "FREE";
    const billingCycle = String(req.body.billingCycle || "MONTHLY").trim().toUpperCase() === "YEARLY" ? "YEARLY" : "MONTHLY";

    if (name.length < 2) {
      res.status(400).json({ ok: false, message: "Le nom doit contenir au moins 2 caracteres." });
      return;
    }
    if (!email || !email.includes("@")) {
      res.status(400).json({ ok: false, message: "Le courriel est invalide." });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ ok: false, message: "Le mot de passe doit contenir au moins 6 caracteres." });
      return;
    }
    if (selectedPlan === "PRO" && username.length < 3) {
      res.status(400).json({ ok: false, message: "Le nom d'utilisateur Pro doit contenir au moins 3 caracteres." });
      return;
    }
    if (selectedPlan === "PRO" && !phone) {
      res.status(400).json({ ok: false, message: "Le numero de telephone est requis pour l'abonnement Pro." });
      return;
    }
    if (selectedPlan === "PRO" && !addressLine1) {
      res.status(400).json({ ok: false, message: "L'adresse est requise pour l'abonnement Pro." });
      return;
    }
    if (selectedPlan === "PRO" && !city) {
      res.status(400).json({ ok: false, message: "La ville est requise pour l'abonnement Pro." });
      return;
    }
    if (selectedPlan === "PRO" && !province) {
      res.status(400).json({ ok: false, message: "La province ou l'etat est requis pour l'abonnement Pro." });
      return;
    }
    if (selectedPlan === "PRO" && !postalCode) {
      res.status(400).json({ ok: false, message: "Le code postal est requis pour l'abonnement Pro." });
      return;
    }

    const existingUser = await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);
    if (existingUser) {
      // Let the user reuse the same email when an old FREE account was never confirmed.
      if (!existingUser.email_verified && existingUser.plan !== "PRO") {
        await runQuery(`DELETE FROM email_verification_tokens WHERE user_id = ?`, [existingUser.id]);
        await runQuery(`DELETE FROM users WHERE id = ?`, [existingUser.id]);
      } else {
        res.status(409).json({ ok: false, message: "Ce courriel est deja utilise." });
        return;
      }
    }
    if (username) {
      const existingUsername = await getQuery(`SELECT id FROM users WHERE lower(username) = lower(?)`, [username]);
      if (existingUsername) {
        res.status(409).json({ ok: false, message: "Ce nom d'utilisateur est deja utilise." });
        return;
      }
    }

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(password, 10);
    let checkoutUrl = null;
    let stripeCustomerId = null;

    if (selectedPlan === "FREE") {
      const result = await runQuery(
        `
          INSERT INTO users (
            name, username, email, phone, address_line1, city, province, postal_code, country, payment_method_preference,
            password_hash, email_verified, plan, stripe_customer_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'FREE', NULL, ?, ?)
        `,
        [
          name,
          username || null,
          email,
          phone,
          addressLine1,
          city,
          province,
          postalCode,
          country,
          paymentMethodPreference,
          passwordHash,
          now,
          now
        ]
      );

      const newUser = await getQuery(`SELECT * FROM users WHERE id = ?`, [result.lastID]);
      res.status(201).json({
        ok: true,
        message: "Compte gratuit cree avec succes. Tu peux te connecter maintenant.",
        selectedPlan: "FREE",
        billingCycle: null,
        checkoutUrl: null,
        emailVerificationRequired: false,
        emailPreviewMode: false,
        verifyUrl: null,
        user: sanitizeUser(newUser)
      });
      return;
    }

    if (selectedPlan === "PRO" && stripeCheckoutConfigured()) {
      const stripe = getStripeClient();
      const customerData = {
        email,
        name,
        phone: phone || undefined,
        address: {
          line1: addressLine1 || undefined,
          city: city || undefined,
          state: province || undefined,
          postal_code: postalCode || undefined,
          country: country || undefined
        },
        metadata: {
          pendingEmail: email,
          username: username || "",
          paymentMethodPreference
        }
      };
      const customer = await stripe.customers.create(customerData);
      stripeCustomerId = customer.id;

      const priceId = billingCycle === "YEARLY" ? STRIPE_PRICE_YEARLY : STRIPE_PRICE_MONTHLY;
      const sessionConfig = {
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: STRIPE_CHECKOUT_SUCCESS_URL,
        cancel_url: STRIPE_CHECKOUT_CANCEL_URL,
        billing_address_collection: "required",
        allow_promotion_codes: true,
        customer_update: {
          address: "auto",
          name: "auto"
        },
        metadata: { pendingEmail: email }
      };

      if (paymentMethodPreference === "PAYPAL") {
        sessionConfig.payment_method_types = ["paypal", "card"];
      } else {
        sessionConfig.payment_method_types = ["card"];
      }

      let session;
      try {
        session = await stripe.checkout.sessions.create(sessionConfig);
      } catch (stripeError) {
        if (paymentMethodPreference === "PAYPAL") {
          res.status(400).json({
            ok: false,
            code: "PAYPAL_NOT_AVAILABLE",
            message: "PayPal n'est pas encore actif sur ce compte Stripe. Active PayPal recurrent dans Stripe ou choisis Visa / Mastercard."
          });
          return;
        }
        throw stripeError;
      }

      checkoutUrl = session.url || null;
    }

    const pending = await createOrReplacePendingRegistration({
      name,
      username: username || null,
      email,
      phone,
      addressLine1,
      city,
      province,
      postalCode,
      country,
      paymentMethodPreference,
      passwordHash,
      selectedPlan,
      billingCycle,
      stripeCustomerId,
      checkoutUrl
    });

    const verification = selectedPlan === "FREE"
      ? await issueVerificationForPending(pending)
      : { verifyUrl: null, emailResult: { sent: false, previewOnly: !canSendEmail() } };

    res.status(201).json({
      ok: true,
      message: selectedPlan === "PRO"
        ? "Renseignements recus. Passe maintenant au paiement. Le courriel de confirmation sera envoye apres validation du paiement."
        : canSendEmail()
          ? "Inscription recue. Confirme maintenant ton courriel pour activer le compte."
          : "Inscription recue. Email non configure localement, utilise le lien de verification fourni.",
      selectedPlan,
      billingCycle: selectedPlan === "PRO" ? billingCycle : null,
      checkoutUrl,
      emailVerificationRequired: true,
      emailPreviewMode: selectedPlan === "FREE" ? !canSendEmail() : false,
      verifyUrl: selectedPlan === "FREE" && !canSendEmail() ? verification.verifyUrl : null,
      pending: {
        username,
        email,
        selectedPlan,
        billingCycle
      }
    });
  } catch (error) {
    console.error("Register error:", error);
    if (error.code === "RESEND_TEST_RECIPIENT_RESTRICTED") {
      res.status(400).json({ ok: false, code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ ok: false, message: "Erreur serveur pendant la creation du compte." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      res.status(400).json({ ok: false, message: "Courriel ou mot de passe manquant." });
      return;
    }

    const user = await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) {
      const pending = await getQuery(`SELECT * FROM pending_registrations WHERE email = ?`, [email]);
      if (pending && await bcrypt.compare(password, pending.password_hash)) {
        res.status(403).json({
          ok: false,
          code: "EMAIL_NOT_VERIFIED",
          message: pending.selected_plan === "PRO"
            ? "Ton abonnement Pro est en attente. Termine le paiement puis confirme ton courriel."
            : "Ton inscription existe, mais ton courriel n'est pas encore confirme. Verifie ta boite courriel."
        });
        return;
      }
    }
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ ok: false, message: "Identifiants invalides." });
      return;
    }

    if (!user.email_verified) {
      res.status(403).json({
        ok: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Ton compte existe, mais ton courriel n'est pas encore confirme."
      });
      return;
    }

    user.plan = await ensureUserPlanCache(user.id);
    res.json({ ok: true, message: "Connexion reussie.", token: signToken(user), user: sanitizeUser(user) });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur pendant la connexion." });
  }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      res.status(400).json({ ok: false, message: "Le courriel est requis." });
      return;
    }

      const pending = await getQuery(`SELECT * FROM pending_registrations WHERE email = ?`, [email]);
      if (pending) {
        if (pending.selected_plan === "PRO") {
          res.status(400).json({
            ok: false,
            message: "Pour un abonnement Pro, le courriel de confirmation est envoye apres la validation du paiement."
          });
          return;
        }
        const verification = await issueVerificationForPending(pending);
        res.json({
          ok: true,
          message: canSendEmail() ? "Un nouveau courriel de verification a ete envoye." : "Email non configure localement, utilise le lien de verification fourni.",
          emailPreviewMode: !canSendEmail(),
          verifyUrl: !canSendEmail() ? verification.verifyUrl : null
        });
        return;
      }

      // Verifier si l'utilisateur existe mais n'a pas encore confirme son courriel (Pro active par webhook)
      const unverifiedUser = await getQuery(`SELECT * FROM users WHERE email = ? AND email_verified = 0`, [email]);
      if (!unverifiedUser) {
        res.status(404).json({ ok: false, message: "Aucune inscription en attente trouvee avec ce courriel." });
        return;
      }
      const verification = await issueVerificationForUser(unverifiedUser);
      res.json({
        ok: true,
        message: canSendEmail() ? "Un nouveau courriel de verification a ete envoye." : "Email non configure localement, utilise le lien de verification fourni.",
        emailPreviewMode: !canSendEmail(),
        verifyUrl: !canSendEmail() ? verification.verifyUrl : null
      });
  } catch (error) {
    console.error("Resend verification error:", error);
    if (error.code === "RESEND_TEST_RECIPIENT_RESTRICTED") {
      res.status(400).json({ ok: false, code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ ok: false, message: "Erreur serveur pendant l'envoi du courriel de verification." });
  }
});

app.post("/api/auth/verify-email", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    if (!token) {
      res.status(400).json({ ok: false, message: "Le token de verification est requis." });
      return;
    }

      const pending = await getQuery(`SELECT * FROM pending_registrations WHERE token = ?`, [token]);

      if (pending) {
        if (new Date(pending.expires_at).getTime() < Date.now()) {
          res.status(400).json({ ok: false, message: "Ce lien de verification a expire." });
          return;
        }
        if (pending.selected_plan === "PRO") {
          res.status(400).json({
            ok: false,
            message: "Le compte Pro doit d'abord etre paye. Le courriel de confirmation est envoye apres validation du paiement."
          });
          return;
        }

        const existingUser = await getQuery(`SELECT * FROM users WHERE email = ?`, [pending.email]);
        if (existingUser) {
          await runQuery(`DELETE FROM pending_registrations WHERE id = ?`, [pending.id]);
          res.status(400).json({ ok: false, message: "Ce compte a deja ete active. Connecte-toi directement." });
          return;
        }

        const now = new Date().toISOString();
        const result = await runQuery(
          `
            INSERT INTO users (
              name, username, email, phone, address_line1, city, province, postal_code, country, payment_method_preference,
              password_hash, email_verified, plan, stripe_customer_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
          `,
          [
            pending.name,
            pending.username,
            pending.email,
            pending.phone,
            pending.address_line1,
            pending.city,
            pending.province,
            pending.postal_code,
            pending.country,
            pending.payment_method_preference,
            pending.password_hash,
            pending.selected_plan || 'FREE',
            pending.stripe_customer_id,
            now,
            now
          ]
        );

        await runQuery(`DELETE FROM pending_registrations WHERE id = ?`, [pending.id]);

        const verifiedUser = await getQuery(`SELECT * FROM users WHERE id = ?`, [result.lastID]);
        verifiedUser.plan = await ensureUserPlanCache(verifiedUser.id);
        res.json({
          ok: true,
          message: "Ton courriel a bien ete confirme et ton compte est maintenant actif.",
          user: sanitizeUser(verifiedUser)
        });
        return;
      }

      // Token absent de pending_registrations — verifier email_verification_tokens (utilisateurs Pro actives par le webhook)
      const tokenRow = await getQuery(
        `SELECT * FROM email_verification_tokens WHERE token = ? AND used_at IS NULL`,
        [token]
      );
      if (!tokenRow) {
        res.status(400).json({ ok: false, message: "Ce lien de verification est invalide ou deja utilise." });
        return;
      }
      if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
        res.status(400).json({ ok: false, message: "Ce lien de verification a expire." });
        return;
      }

      const now = new Date().toISOString();
      await runQuery(`UPDATE email_verification_tokens SET used_at = ? WHERE id = ?`, [now, tokenRow.id]);
      await runQuery(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`, [now, tokenRow.user_id]);

      const verifiedUser = await getQuery(`SELECT * FROM users WHERE id = ?`, [tokenRow.user_id]);
      verifiedUser.plan = await ensureUserPlanCache(verifiedUser.id);
      res.json({
        ok: true,
        message: "Ton courriel a bien ete confirme et ton compte est maintenant actif.",
        user: sanitizeUser(verifiedUser)
      });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur pendant la verification du courriel." });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  const billing = await getBillingStatusForUser(req.user);
  res.json({ ok: true, user: billing.user, billing });
});

app.get("/api/billing/status", authMiddleware, async (req, res) => {
  try {
    const billing = await getBillingStatusForUser(req.user);
    res.json({ ok: true, billing });
  } catch (error) {
    console.error("Billing status error:", error);
    res.status(500).json({ ok: false, message: "Impossible de charger l'abonnement." });
  }
});

app.post("/api/billing/create-checkout-session", authMiddleware, async (req, res) => {
  try {
    if (!stripeCheckoutConfigured()) {
      res.status(400).json({ ok: false, message: "Stripe n'est pas encore configure." });
      return;
    }

    const priceId = String(req.body.priceId || "");
    if (![STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY].includes(priceId)) {
      res.status(400).json({ ok: false, message: "Offre Stripe invalide." });
      return;
    }

    const stripe = getStripeClient();
    let customerId = req.user.stripe_customer_id || "";

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name,
        metadata: { userId: String(req.user.id) }
      });
      customerId = customer.id;
      await runQuery(`UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`, [customerId, new Date().toISOString(), req.user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: STRIPE_CHECKOUT_SUCCESS_URL,
      cancel_url: STRIPE_CHECKOUT_CANCEL_URL,
      allow_promotion_codes: false,
      metadata: { userId: String(req.user.id) }
    });

    res.json({ ok: true, url: session.url });
  } catch (error) {
    console.error("Create checkout session error:", error);
    res.status(500).json({ ok: false, message: "Impossible de lancer le paiement Stripe." });
  }
});

app.post("/api/billing/create-customer-portal", authMiddleware, async (req, res) => {
  try {
    if (!stripeConfigured()) {
      res.status(400).json({ ok: false, message: "Stripe n'est pas configure." });
      return;
    }
    if (!req.user.stripe_customer_id) {
      res.status(400).json({ ok: false, message: "Aucun client Stripe trouve pour ce compte." });
      return;
    }

    const stripe = getStripeClient();
    const portal = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: STRIPE_CUSTOMER_PORTAL_RETURN_URL
    });

    res.json({ ok: true, url: portal.url });
  } catch (error) {
    console.error("Create portal error:", error);
    res.status(500).json({ ok: false, message: "Impossible d'ouvrir la gestion d'abonnement." });
  }
});

app.post("/api/stripe/webhook", async (req, res) => {
  try {
    if (!stripeConfigured() || !STRIPE_WEBHOOK_SECRET) {
      res.status(400).send("Stripe webhook non configure.");
      return;
    }

    const stripe = getStripeClient();
    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      console.error("Stripe signature error:", error.message);
      res.status(400).send(`Webhook Error: ${error.message}`);
      return;
    }

    const object = event.data.object;

    if (event.type === "checkout.session.completed") {
      const fallbackUserId = Number(object.metadata?.userId || 0) || null;
      if (object.subscription) {
        const subscription = await stripe.subscriptions.retrieve(object.subscription);
        const user = await syncStripeSubscription(subscription, fallbackUserId);
        await recordStripeEvent(event, user.id);
      } else {
        await recordStripeEvent(event, fallbackUserId);
      }
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const user = await syncStripeSubscription(object);
      await recordStripeEvent(event, user.id);
    }

    if (event.type === "invoice.payment_succeeded" || event.type === "invoice.payment_failed") {
      const user = object.customer ? await findUserByStripeCustomerId(String(object.customer)) : null;
      if (user) {
        await ensureUserPlanCache(user.id);
        await recordStripeEvent(event, user.id);
      } else {
        await recordStripeEvent(event, null);
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    res.status(500).send("Stripe webhook server error.");
  }
});

app.get("/api/tickets", authMiddleware, async (req, res) => {
  try {
    const rows = await allQuery(
      `
        SELECT id, game, draw_date, numbers_json, cost, winnings, notes, source, ticket_number, barcode_value, created_at, updated_at
        FROM tickets
        WHERE user_id = ?
        ORDER BY draw_date DESC, id DESC
      `,
      [req.user.id]
    );
    res.json({ ok: true, tickets: rows.map(serializeTicket) });
  } catch (error) {
    console.error("Tickets GET error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur pendant la lecture des tickets." });
  }
});

app.post("/api/tickets", authMiddleware, async (req, res) => {
  try {
    const game = String(req.body.game || "").trim();
    const drawDate = String(req.body.drawDate || "").trim();
    const numbers = normalizeNumbers(req.body.numbers);
    const cost = Number(req.body.cost || 0);
    const winnings = Number(req.body.winnings || 0);
    const notes = String(req.body.notes || "").trim();
    const source = String(req.body.source || "MANUAL").trim().toUpperCase();
    const ticketNumber = String(req.body.ticketNumber || "").trim();
    const barcodeValue = String(req.body.barcodeValue || "").trim();

    if (!game) {
      res.status(400).json({ ok: false, message: "Le jeu est requis." });
      return;
    }
    if (!drawDate) {
      res.status(400).json({ ok: false, message: "La date du tirage est requise." });
      return;
    }
    if (!numbers.length) {
      res.status(400).json({ ok: false, message: "Ajoute au moins un numero valide." });
      return;
    }
    if (Number.isNaN(cost) || cost < 0 || Number.isNaN(winnings) || winnings < 0) {
      res.status(400).json({ ok: false, message: "Les montants sont invalides." });
      return;
    }
    if (source === "SCAN" && req.user.plan !== "PRO") {
      res.status(403).json({ ok: false, code: "PLAN_UPGRADE_REQUIRED", message: "Le scan automatique est reserve au plan Pro." });
      return;
    }

    const now = new Date().toISOString();
    const result = await runQuery(
      `
        INSERT INTO tickets (user_id, game, draw_date, numbers_json, cost, winnings, notes, source, ticket_number, barcode_value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [req.user.id, game, drawDate, JSON.stringify(numbers), cost, winnings, notes, source, ticketNumber, barcodeValue, now, now]
    );

    const ticketRow = await getQuery(
      `
        SELECT id, game, draw_date, numbers_json, cost, winnings, notes, source, ticket_number, barcode_value, created_at, updated_at
        FROM tickets
        WHERE id = ? AND user_id = ?
      `,
      [result.lastID, req.user.id]
    );

    res.status(201).json({ ok: true, message: "Ticket ajoute avec succes.", ticket: serializeTicket(ticketRow) });
  } catch (error) {
    console.error("Tickets POST error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur pendant l'ajout du ticket." });
  }
});

app.put("/api/tickets/:id", authMiddleware, async (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      res.status(400).json({ ok: false, message: "ID ticket invalide." });
      return;
    }

    const existingTicket = await getQuery(`SELECT * FROM tickets WHERE id = ? AND user_id = ?`, [ticketId, req.user.id]);
    if (!existingTicket) {
      res.status(404).json({ ok: false, message: "Ticket introuvable." });
      return;
    }

    const game = String(req.body.game || "").trim();
    const drawDate = String(req.body.drawDate || "").trim();
    const numbers = normalizeNumbers(req.body.numbers);
    const cost = Number(req.body.cost || 0);
    const winnings = Number(req.body.winnings || 0);
    const notes = String(req.body.notes || "").trim();
    const source = String(req.body.source || existingTicket.source || "MANUAL").trim().toUpperCase();
    const ticketNumber = String(req.body.ticketNumber ?? existingTicket.ticket_number ?? "").trim();
    const barcodeValue = String(req.body.barcodeValue ?? existingTicket.barcode_value ?? "").trim();

    if (!game || !drawDate || !numbers.length) {
      res.status(400).json({ ok: false, message: "Les donnees du ticket sont invalides." });
      return;
    }
    if (Number.isNaN(cost) || cost < 0 || Number.isNaN(winnings) || winnings < 0) {
      res.status(400).json({ ok: false, message: "Les montants sont invalides." });
      return;
    }
    if (source === "SCAN" && req.user.plan !== "PRO") {
      res.status(403).json({ ok: false, code: "PLAN_UPGRADE_REQUIRED", message: "Le scan automatique est reserve au plan Pro." });
      return;
    }

    await runQuery(
      `
        UPDATE tickets
        SET game = ?, draw_date = ?, numbers_json = ?, cost = ?, winnings = ?, notes = ?, source = ?, ticket_number = ?, barcode_value = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
      [game, drawDate, JSON.stringify(numbers), cost, winnings, notes, source, ticketNumber, barcodeValue, new Date().toISOString(), ticketId, req.user.id]
    );

    const ticketRow = await getQuery(
      `
        SELECT id, game, draw_date, numbers_json, cost, winnings, notes, source, ticket_number, barcode_value, created_at, updated_at
        FROM tickets
        WHERE id = ? AND user_id = ?
      `,
      [ticketId, req.user.id]
    );

    res.json({ ok: true, message: "Ticket mis a jour avec succes.", ticket: serializeTicket(ticketRow) });
  } catch (error) {
    console.error("Tickets PUT error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur pendant la modification." });
  }
});

app.delete("/api/tickets/:id", authMiddleware, async (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      res.status(400).json({ ok: false, message: "ID ticket invalide." });
      return;
    }

    const result = await runQuery(`DELETE FROM tickets WHERE id = ? AND user_id = ?`, [ticketId, req.user.id]);
    if (!result.changes) {
      res.status(404).json({ ok: false, message: "Ticket introuvable." });
      return;
    }

    res.json({ ok: true, message: "Ticket supprime avec succes." });
  } catch (error) {
    console.error("Tickets DELETE error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur pendant la suppression." });
  }
});

app.get("/api/dashboard/summary", authMiddleware, async (req, res) => {
  try {
    const summary = await buildSummaryForUser(req.user.id);
    res.json({ ok: true, summary });
  } catch (error) {
    console.error("Dashboard summary error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur pendant le calcul du tableau de bord." });
  }
});

app.get("*", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }
  res.status(200).send("<h1>LottoTracker Unified</h1><p>Le backend fonctionne, mais public/index.html est introuvable.</p>");
});

// ─── Routes Admin ────────────────────────────────────────────────────────────

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.post("/api/admin/login", async (req, res) => {
  try {
    if (!ADMIN_PASSWORD) {
      res.status(503).json({ ok: false, message: "Page admin non configurée. Définir ADMIN_PASSWORD dans les variables d'environnement." });
      return;
    }
    const { password, mfaToken } = req.body;
    if (!password || password !== ADMIN_PASSWORD) {
      res.status(401).json({ ok: false, message: "Mot de passe incorrect." });
      return;
    }
    if (ADMIN_MFA_SECRET) {
      if (!mfaToken) {
        res.status(401).json({ ok: false, code: "MFA_REQUIRED", message: "Code MFA requis." });
        return;
      }
      if (!verifyTOTP(ADMIN_MFA_SECRET, String(mfaToken))) {
        res.status(401).json({ ok: false, message: "Code MFA invalide ou expiré." });
        return;
      }
    }
    res.json({ ok: true, token: signAdminToken(), mfaEnabled: Boolean(ADMIN_MFA_SECRET) });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

app.get("/api/admin/users", adminAuthMiddleware, async (req, res) => {
  try {
    const users = await allQuery(`
      SELECT u.id, u.name, u.email, u.plan, u.plan_gifted, u.email_verified, u.stripe_customer_id, u.created_at,
             s.status AS sub_status, s.billing_cycle, s.current_period_end
      FROM users u
      LEFT JOIN subscriptions s ON s.id = (SELECT MAX(id) FROM subscriptions WHERE user_id = u.id)
      ORDER BY u.created_at DESC
    `);
    res.json({ ok: true, users });
  } catch (error) {
    console.error("Admin users error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

app.post("/api/admin/users/:id/set-plan", adminAuthMiddleware, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { plan } = req.body;
    if (!["PRO", "FREE"].includes(plan)) {
      res.status(400).json({ ok: false, message: "Plan invalide." });
      return;
    }
    const gifted = plan === "PRO" ? 1 : 0;
    await runQuery(`UPDATE users SET plan = ?, plan_gifted = ?, updated_at = ? WHERE id = ?`, [plan, gifted, new Date().toISOString(), userId]);
    res.json({ ok: true, message: `Plan mis à jour : ${plan}` });
  } catch (error) {
    console.error("Admin set-plan error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

app.get("/api/admin/promos", adminAuthMiddleware, async (req, res) => {
  try {
    if (!stripeConfigured()) { res.json({ ok: true, promos: [] }); return; }
    const stripe = getStripeClient();
    const list = await stripe.promotionCodes.list({ limit: 50, expand: ["data.coupon"] });
    const promos = list.data.map(p => ({
      id: p.id, code: p.code, active: p.active,
      timesRedeemed: p.times_redeemed, maxRedemptions: p.max_redemptions,
      coupon: { percentOff: p.coupon.percent_off, amountOff: p.coupon.amount_off ? p.coupon.amount_off / 100 : null, duration: p.coupon.duration }
    }));
    res.json({ ok: true, promos });
  } catch (error) {
    console.error("Admin promos list error:", error);
    res.status(500).json({ ok: false, message: error.message || "Erreur serveur." });
  }
});

app.post("/api/admin/promo/create", adminAuthMiddleware, async (req, res) => {
  try {
    if (!stripeConfigured()) { res.status(503).json({ ok: false, message: "Stripe non configuré." }); return; }
    const stripe = getStripeClient();
    const { percentOff, amountOff, duration, durationMonths, code, maxRedemptions } = req.body;
    const couponData = { duration: duration || "once" };
    if (percentOff) couponData.percent_off = Number(percentOff);
    else if (amountOff) { couponData.amount_off = Math.round(Number(amountOff) * 100); couponData.currency = "cad"; }
    else { res.status(400).json({ ok: false, message: "percent_off ou amount_off requis." }); return; }
    if (duration === "repeating") couponData.duration_in_months = Number(durationMonths || 3);
    const coupon = await stripe.coupons.create(couponData);
    const promoData = { coupon: coupon.id };
    if (code) promoData.code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (maxRedemptions) promoData.max_redemptions = Number(maxRedemptions);
    const promo = await stripe.promotionCodes.create(promoData);
    res.json({ ok: true, promo: { id: promo.id, code: promo.code } });
  } catch (error) {
    console.error("Admin promo create error:", error);
    res.status(500).json({ ok: false, message: error.message || "Erreur serveur." });
  }
});

app.post("/api/admin/email/send", adminAuthMiddleware, async (req, res) => {
  try {
    if (!canSendEmail()) { res.status(503).json({ ok: false, message: "Resend non configuré." }); return; }
    const { userIds, subject, body } = req.body;
    if (!Array.isArray(userIds) || !userIds.length || !subject || !body) {
      res.status(400).json({ ok: false, message: "userIds, subject et body requis." }); return;
    }
    const placeholders = userIds.map(() => "?").join(",");
    const users = await allQuery(`SELECT id, name, email FROM users WHERE id IN (${placeholders})`, userIds);
    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        const html = String(body).replace(/\{nom\}/gi, user.name).replace(/\{email\}/gi, user.email);
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: user.email, subject, html })
        });
        if (r.ok) sent++; else failed++;
      } catch (e) { failed++; }
    }
    res.json({ ok: true, message: `Envoyé : ${sent} · Échec : ${failed}` });
  } catch (error) {
    console.error("Admin email send error:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

initDatabase()
  .then(() => {
    if (JWT_SECRET === "change-me-in-production") {
      console.warn("Warning: JWT_SECRET is using the default development value.");
    }
    if (!canSendEmail()) {
      console.warn("Warning: Resend email is not configured. Verification links will be returned in API responses.");
    }
    if (!stripeConfigured()) {
      console.warn("Warning: Stripe is not configured yet.");
    }

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization error:", error);
    process.exit(1);
  });
