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
      email TEXT NOT NULL UNIQUE,
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
      email TEXT NOT NULL UNIQUE,
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
    email: user.email,
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

async function createOrReplacePendingRegistration({ name, email, passwordHash, selectedPlan, billingCycle, stripeCustomerId = null, checkoutUrl = null }) {
  const now = new Date().toISOString();
  const token = generateVerificationToken();
  const expiresAt = getVerificationExpiry();

  await runQuery(`DELETE FROM pending_registrations WHERE email = ?`, [email]);

  const result = await runQuery(
    `
      INSERT INTO pending_registrations (
        name, email, password_hash, selected_plan, billing_cycle, stripe_customer_id, checkout_url, token, expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [name, email, passwordHash, selectedPlan, billingCycle, stripeCustomerId, checkoutUrl, token, expiresAt, now, now]
  );

  return getQuery(`SELECT * FROM pending_registrations WHERE id = ?`, [result.lastID]);
}

async function issueVerificationForPending(pending) {
  const verifyUrl = buildVerificationUrl(pending.token);
  const emailResult = await sendVerificationEmail({
    email: pending.email,
    name: pending.name,
    verifyUrl
  });

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
  const subscription = await getLatestSubscriptionForUser(userId);
  if (subscription && activePlanFromStatus(subscription.status) === "PRO") {
    return "PRO";
  }
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
    `INSERT INTO users (name, email, password_hash, email_verified, plan, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, 0, 'PRO', ?, ?, ?)`,
    [pending.name, pending.email, pending.password_hash, customerId, now, now]
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
    const email = normalizeEmail(req.body.email);
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

    const existingUser = await getQuery(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existingUser) {
      res.status(409).json({ ok: false, message: "Ce courriel est deja utilise." });
      return;
    }

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(password, 10);
    let checkoutUrl = null;
    let stripeCustomerId = null;

    if (selectedPlan === "PRO" && stripeCheckoutConfigured()) {
      const stripe = getStripeClient();
      const customer = await stripe.customers.create({
        email,
        name,
        metadata: { pendingEmail: email }
      });
      stripeCustomerId = customer.id;

      const priceId = billingCycle === "YEARLY" ? STRIPE_PRICE_YEARLY : STRIPE_PRICE_MONTHLY;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: STRIPE_CHECKOUT_SUCCESS_URL,
        cancel_url: STRIPE_CHECKOUT_CANCEL_URL,
        billing_address_collection: "auto",
        allow_promotion_codes: false,
        metadata: { pendingEmail: email }
      });

      checkoutUrl = session.url || null;
    }

    const pending = await createOrReplacePendingRegistration({
      name,
      email,
      passwordHash,
      selectedPlan,
      billingCycle,
      stripeCustomerId,
      checkoutUrl
    });

    const verification = await issueVerificationForPending(pending);

    res.status(201).json({
      ok: true,
      message: canSendEmail()
        ? "Inscription recue. Confirme maintenant ton courriel pour activer le compte."
        : "Inscription recue. Email non configure localement, utilise le lien de verification fourni.",
      selectedPlan,
      billingCycle: selectedPlan === "PRO" ? billingCycle : null,
      checkoutUrl,
      emailVerificationRequired: true,
      emailPreviewMode: !canSendEmail(),
      verifyUrl: !canSendEmail() ? verification.verifyUrl : null,
      pending: {
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

        const existingUser = await getQuery(`SELECT * FROM users WHERE email = ?`, [pending.email]);
        if (existingUser) {
          await runQuery(`DELETE FROM pending_registrations WHERE id = ?`, [pending.id]);
          res.status(400).json({ ok: false, message: "Ce compte a deja ete active. Connecte-toi directement." });
          return;
        }

        const now = new Date().toISOString();
        const result = await runQuery(
          `INSERT INTO users (name, email, password_hash, email_verified, plan, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'FREE', ?, ?, ?)`,
          [pending.name, pending.email, pending.password_hash, pending.stripe_customer_id, now, now]
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
