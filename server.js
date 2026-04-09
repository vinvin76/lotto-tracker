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
const DB_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DB_DIR, "lotto_tracker.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");

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
app.use(express.json({ limit: "2mb" }));
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await addColumnIfMissing("users", "email_verified", "INTEGER NOT NULL DEFAULT 0");

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

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

  await runQuery(`CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_tickets_draw_date ON tickets(draw_date)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id ON email_verification_tokens(user_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_email_tokens_token ON email_verification_tokens(token)`);

  console.log("Database initialized.");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeJsonParse(value, fallback = []) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function signToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getVerificationExpiry() {
  return new Date(Date.now() + VERIFICATION_HOURS * 60 * 60 * 1000).toISOString();
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

  return {
    token,
    expiresAt
  };
}

function buildVerificationUrl(token) {
  return `${APP_BASE_URL}/?verify=${encodeURIComponent(token)}`;
}

function canSendEmail() {
  return Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);
}

async function sendVerificationEmail({ email, name, verifyUrl }) {
  if (!canSendEmail()) {
    return {
      sent: false,
      previewOnly: true
    };
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
          <p>
            <a href="${verifyUrl}" style="display:inline-block;padding:12px 18px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;">
              Confirmer mon courriel
            </a>
          </p>
          <p>Si le bouton ne fonctionne pas, copie ce lien dans ton navigateur :</p>
          <p>${verifyUrl}</p>
        </div>
      `
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend error: ${response.status} ${text}`);
  }

  return {
    sent: true,
    previewOnly: false
  };
}

async function issueVerificationForUser(user) {
  await runQuery(
    `
      UPDATE email_verification_tokens
      SET used_at = ?
      WHERE user_id = ? AND used_at IS NULL
    `,
    [new Date().toISOString(), user.id]
  );

  const tokenData = await createVerificationToken(user.id);
  const verifyUrl = buildVerificationUrl(tokenData.token);
  const emailResult = await sendVerificationEmail({
    email: user.email,
    name: user.name,
    verifyUrl
  });

  return {
    verifyUrl,
    emailResult
  };
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      res.status(401).json({
        ok: false,
        message: "Acces non autorise."
      });
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await getQuery(
      `
        SELECT id, name, email, email_verified, created_at, updated_at
        FROM users
        WHERE id = ?
      `,
      [decoded.userId]
    );

    if (!user) {
      res.status(401).json({
        ok: false,
        message: "Utilisateur introuvable."
      });
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

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({
      ok: false,
      message: "Session invalide ou expiree."
    });
  }
}

async function buildSummaryForUser(userId) {
  const rows = await allQuery(
    `
      SELECT game, cost, winnings, numbers_json
      FROM tickets
      WHERE user_id = ?
    `,
    [userId]
  );

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

  return {
    totalTickets,
    totalSpent,
    totalWon,
    netResult,
    topNumbers,
    games
  };
}

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    app: "LottoTracker Unified",
    time: new Date().toISOString(),
    emailProviderConfigured: canSendEmail()
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

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

    const existingUser = await getQuery(
      "SELECT id, email_verified FROM users WHERE email = ?",
      [email]
    );

    if (existingUser) {
      res.status(409).json({
        ok: false,
        message: "Ce courriel est deja utilise."
      });
      return;
    }

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await runQuery(
      `
        INSERT INTO users (name, email, password_hash, email_verified, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `,
      [name, email, passwordHash, now, now]
    );

    const user = await getQuery(
      `
        SELECT id, name, email, email_verified, created_at, updated_at
        FROM users
        WHERE id = ?
      `,
      [result.lastID]
    );

    const verification = await issueVerificationForUser(user);

    res.status(201).json({
      ok: true,
      message: canSendEmail()
        ? "Compte cree. Verifie maintenant ton courriel."
        : "Compte cree. Email non configure localement, utilise le lien de verification fourni.",
      emailVerificationRequired: true,
      emailPreviewMode: !canSendEmail(),
      verifyUrl: !canSendEmail() ? verification.verifyUrl : null,
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur pendant la creation du compte."
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      res.status(400).json({
        ok: false,
        message: "Courriel ou mot de passe manquant."
      });
      return;
    }

    const user = await getQuery("SELECT * FROM users WHERE email = ?", [email]);

    if (!user) {
      res.status(401).json({ ok: false, message: "Identifiants invalides." });
      return;
    }

    const passwordIsValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordIsValid) {
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

    res.json({
      ok: true,
      message: "Connexion reussie.",
      token: signToken(user),
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur pendant la connexion."
    });
  }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      res.status(400).json({
        ok: false,
        message: "Le courriel est requis."
      });
      return;
    }

    const user = await getQuery(
      `
        SELECT id, name, email, email_verified, created_at, updated_at
        FROM users
        WHERE email = ?
      `,
      [email]
    );

    if (!user) {
      res.status(404).json({
        ok: false,
        message: "Aucun compte trouve avec ce courriel."
      });
      return;
    }

    if (user.email_verified) {
      res.status(400).json({
        ok: false,
        message: "Ce compte est deja confirme."
      });
      return;
    }

    const verification = await issueVerificationForUser(user);

    res.json({
      ok: true,
      message: canSendEmail()
        ? "Un nouveau courriel de verification a ete envoye."
        : "Email non configure localement, utilise le lien de verification fourni.",
      emailPreviewMode: !canSendEmail(),
      verifyUrl: !canSendEmail() ? verification.verifyUrl : null
    });
  } catch (error) {
    console.error("Resend verification error:", error);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur pendant l'envoi du courriel de verification."
    });
  }
});

app.post("/api/auth/verify-email", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();

    if (!token) {
      res.status(400).json({
        ok: false,
        message: "Le token de verification est requis."
      });
      return;
    }

    const tokenRow = await getQuery(
      `
        SELECT id, user_id, token, expires_at, created_at, used_at
        FROM email_verification_tokens
        WHERE token = ?
      `,
      [token]
    );

    if (!tokenRow || tokenRow.used_at) {
      res.status(400).json({
        ok: false,
        message: "Ce lien de verification est invalide ou deja utilise."
      });
      return;
    }

    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      res.status(400).json({
        ok: false,
        message: "Ce lien de verification a expire."
      });
      return;
    }

    const user = await getQuery(
      `
        SELECT id, name, email, email_verified, created_at, updated_at
        FROM users
        WHERE id = ?
      `,
      [tokenRow.user_id]
    );

    if (!user) {
      res.status(404).json({
        ok: false,
        message: "Utilisateur introuvable."
      });
      return;
    }

    const now = new Date().toISOString();

    await runQuery(
      `
        UPDATE users
        SET email_verified = 1, updated_at = ?
        WHERE id = ?
      `,
      [now, user.id]
    );

    await runQuery(
      `
        UPDATE email_verification_tokens
        SET used_at = ?
        WHERE id = ?
      `,
      [now, tokenRow.id]
    );

    const verifiedUser = await getQuery(
      `
        SELECT id, name, email, email_verified, created_at, updated_at
        FROM users
        WHERE id = ?
      `,
      [user.id]
    );

    res.json({
      ok: true,
      message: "Ton courriel a bien ete confirme. Tu peux maintenant te connecter.",
      user: sanitizeUser(verifiedUser)
    });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur pendant la verification du courriel."
    });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  res.json({
    ok: true,
    user: sanitizeUser(req.user)
  });
});

app.get("/api/tickets", authMiddleware, async (req, res) => {
  try {
    const rows = await allQuery(
      `
        SELECT id, game, draw_date, numbers_json, cost, winnings, notes, created_at, updated_at
        FROM tickets
        WHERE user_id = ?
        ORDER BY draw_date DESC, id DESC
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      tickets: rows.map(serializeTicket)
    });
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

    const now = new Date().toISOString();
    const result = await runQuery(
      `
        INSERT INTO tickets (
          user_id, game, draw_date, numbers_json, cost, winnings, notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [req.user.id, game, drawDate, JSON.stringify(numbers), cost, winnings, notes, now, now]
    );

    const ticketRow = await getQuery(
      `
        SELECT id, game, draw_date, numbers_json, cost, winnings, notes, created_at, updated_at
        FROM tickets
        WHERE id = ? AND user_id = ?
      `,
      [result.lastID, req.user.id]
    );

    res.status(201).json({
      ok: true,
      message: "Ticket ajoute avec succes.",
      ticket: serializeTicket(ticketRow)
    });
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

    const existingTicket = await getQuery(
      "SELECT id FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.user.id]
    );

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

    if (!game || !drawDate || !numbers.length) {
      res.status(400).json({ ok: false, message: "Les donnees du ticket sont invalides." });
      return;
    }

    if (Number.isNaN(cost) || cost < 0 || Number.isNaN(winnings) || winnings < 0) {
      res.status(400).json({ ok: false, message: "Les montants sont invalides." });
      return;
    }

    const now = new Date().toISOString();

    await runQuery(
      `
        UPDATE tickets
        SET game = ?, draw_date = ?, numbers_json = ?, cost = ?, winnings = ?, notes = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
      [game, drawDate, JSON.stringify(numbers), cost, winnings, notes, now, ticketId, req.user.id]
    );

    const ticketRow = await getQuery(
      `
        SELECT id, game, draw_date, numbers_json, cost, winnings, notes, created_at, updated_at
        FROM tickets
        WHERE id = ? AND user_id = ?
      `,
      [ticketId, req.user.id]
    );

    res.json({
      ok: true,
      message: "Ticket mis a jour avec succes.",
      ticket: serializeTicket(ticketRow)
    });
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

    const result = await runQuery(
      "DELETE FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.user.id]
    );

    if (!result.changes) {
      res.status(404).json({ ok: false, message: "Ticket introuvable." });
      return;
    }

    res.json({
      ok: true,
      message: "Ticket supprime avec succes."
    });
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

  res.status(200).send(`
    <h1>LottoTracker Unified</h1>
    <p>Le backend fonctionne, mais public/index.html est introuvable.</p>
  `);
});

initDatabase()
  .then(() => {
    if (JWT_SECRET === "change-me-in-production") {
      console.warn("Warning: JWT_SECRET is using the default development value.");
    }

    if (!canSendEmail()) {
      console.warn("Warning: Resend email is not configured. Verification links will be returned in API responses.");
    }

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization error:", error);
    process.exit(1);
  });
