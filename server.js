const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const url = require("url");

require("dotenv").config();
const admin = require("firebase-admin");

function cleanEnvString(v) {
  if (typeof v !== "string") return "";
  return v.replace(/^["']/, "").replace(/["']$/, "");
}

const FIREBASE_DATABASE_URL = cleanEnvString(process.env.FIREBASE_DATABASE_URL);
const GOOGLE_APPLICATION_CREDENTIALS = cleanEnvString(process.env.GOOGLE_APPLICATION_CREDENTIALS);

let rtdb = null;
if (FIREBASE_DATABASE_URL && GOOGLE_APPLICATION_CREDENTIALS) {
  const serviceAccount = require(GOOGLE_APPLICATION_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FIREBASE_DATABASE_URL,
  });
  rtdb = admin.database();
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
// Static site files live in the current working directory (HTML + MEDIA/ + data/)
const SITE_DIR = process.cwd();
const DATA_DIR = path.join(SITE_DIR, "data");
const CONTACT_LOG = path.join(DATA_DIR, "contact_submissions.jsonl");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// Decode percent-encoding so requests like /MEDIA/Logo%20file.png
// map to actual files with spaces.
function safeJoin(rootDir, reqPath) {
  const rel = reqPath.replace(/^\/+/, "");
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    // if decoding fails, keep raw value
  }

  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(rootDir, normalized);
}

async function ensureDataDir() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = text ?? "";
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function handleContactPost(req, res) {
  let raw = "";
  req.setEncoding("utf8");

  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 2_000_000) {
      res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Payload too large");
      req.destroy();
    }
  });

  req.on("end", async () => {
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }

    // Basic validation
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const eventType = typeof payload.eventType === "string" ? payload.eventType.trim() : "";
    const message = typeof payload.message === "string" ? payload.message.trim() : "";

    if (!name || !email || !message) {
      return sendJson(res, 422, { ok: false, error: "name, email, message are required" });
    }

    await ensureDataDir();

    const record = {
      id: Math.random().toString(16).slice(2),
      at: new Date().toISOString(),
      name,
      email,
      phone,
      eventType,
      message,
      userAgent: req.headers["user-agent"] ?? "",
      ip: (req.socket && req.socket.remoteAddress) || "",
    };

    try {
      if (rtdb) {
        await rtdb.ref("contact_submissions").push(record);
      } else {
        await fsp.appendFile(CONTACT_LOG, JSON.stringify(record) + "\n", "utf8");
      }
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Failed to write contact submission", details: String(e?.message || e) });
    }

    return sendJson(res, 200, { ok: true });
  });
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

// SHOP / PROFORMA API HELPERS
const SHOP_CATALOG_PATH = path.join(SITE_DIR, "data", "shop_catalog.json");
const PROFORMA_LOG = path.join(DATA_DIR, "proforma_requests.jsonl");

function toText(s) {
  return String(s ?? "");
}

function formatMoney(n, currencyLabel) {
  const num = typeof n === "number" ? n : Number(n);
  const label =
    typeof currencyLabel === "string" && currencyLabel.trim()
      ? currencyLabel.trim()
      : "XAF";
  if (!Number.isFinite(num)) return `${String(n)} ${label}`;
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(num) + " " + label;
}

async function readShopCatalog() {
  if (rtdb) {
    const snap = await rtdb.ref("shop_catalog").get();
    const parsed = snap.val();
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid shop_catalog RTDB value");
    if (!Array.isArray(parsed.items) || !Array.isArray(parsed.categories)) throw new Error("Catalog missing items/categories");
    return parsed;
  }

  const raw = await fsp.readFile(SHOP_CATALOG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid catalog JSON");
  if (!Array.isArray(parsed.items) || !Array.isArray(parsed.categories)) throw new Error("Catalog missing items/categories");
  return parsed;
}

function buildProformaHtml({ proformaNo, customer, event, days, lines, totals, currencyLabel }) {
  const lineRows = lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 8px;border:1px solid #eaeaea;">${toText(l.title)}</td>
        <td style="padding:10px 8px;border:1px solid #eaeaea;text-align:center;">${toText(String(l.categoryLabel))}</td>
        <td style="padding:10px 8px;border:1px solid #eaeaea;text-align:center;">${toText(String(l.kindLabel))}</td>
        <td style="padding:10px 8px;border:1px solid #eaeaea;text-align:center;">${toText(String(l.qty))}</td>
        <td style="padding:10px 8px;border:1px solid #eaeaea;text-align:right;">${toText(formatMoney(l.pricePerDay * l.qty, currencyLabel))}</td>
      </tr>
    `
    )
    .join("");

  const subtotal = totals.subtotal;
  const total = totals.total;

  return `<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.4; color:#111;">
    <div style="max-width: 760px; margin: 0 auto; padding: 22px;">
      <h2 style="margin: 0 0 10px;">OSSPROGROUP — Proforma de location</h2>
      <div style="margin-bottom: 18px; color:#555;">
        <div><b>Référence :</b> ${toText(proformaNo)}</div>
        <div><b>Client :</b> ${toText(customer.name)} (${toText(customer.email)})</div>
        <div><b>Téléphone :</b> ${toText(customer.phone || "")}</div>
        <div><b>Événement :</b> ${toText(event.eventType || "")}</div>
        <div><b>Lieu :</b> ${toText(event.location || "")}</div>
        <div><b>Durée :</b> ${toText(String(days))} ${toText("jour")}</div>
      </div>

      <table style="width:100%; border-collapse: collapse; margin-bottom: 16px;">
        <thead>
          <tr>
            <th style="padding:10px 8px;border:1px solid #eaeaea;background:#fafafa;text-align:left;">Produit</th>
            <th style="padding:10px 8px;border:1px solid #eaeaea;background:#fafafa;">Catégorie</th>
            <th style="padding:10px 8px;border:1px solid #eaeaea;background:#fafafa;">Type</th>
            <th style="padding:10px 8px;border:1px solid #eaeaea;background:#fafafa;">Qté</th>
            <th style="padding:10px 8px;border:1px solid #eaeaea;background:#fafafa;text-align:right;">Prix / jour (total ligne)</th>
          </tr>
        </thead>
        <tbody>
          ${lineRows}
        </tbody>
      </table>

      <div style="display:flex;justify-content:flex-end;">
        <div style="min-width:280px;">
          <div style="margin-bottom:6px; color:#555;"><b>Sous-total (par jour) :</b> ${toText(formatMoney(subtotal, currencyLabel))}</div>
          <div style="margin-bottom:6px; color:#555;"><b>Nombre de jours :</b> ${toText(String(days))}</div>
          <div style="font-size:18px; margin-top:10px;"><b>Total proforma :</b> ${toText(formatMoney(total, currencyLabel))}</div>
          <div style="margin-top:10px; color:#666; font-size:12px;">
            Prix en ${toText(currencyLabel)} — sans paiement en ligne (commande sur confirmation).
          </div>
        </div>
      </div>

      <div style="margin-top:18px; color:#444; font-size:12.5px;">
        <b>Suivant :</b> merci de confirmer par email et nous préciser vos dates exactes. Nous préparons ensuite la logistique et l’affectation des techniciens.
      </div>
    </div>
  </body>
</html>`;
}

async function appendProformaLog(record) {
  try {
    if (rtdb) {
      await rtdb.ref("proforma_requests").push(record);
      return;
    }
    await ensureDataDir();
    await fsp.appendFile(PROFORMA_LOG, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // ignore
  }
}

async function sendWithResend({ apiKey, from, to, subject, html }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const details = data ? JSON.stringify(data) : "";
    throw new Error(`Resend error ${resp.status}: ${details}`);
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || "/";

    // API routes
    if (pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    }

    // Media listing (used by admin to avoid hardcoded filename arrays)
    if (pathname === "/api/media/list" && req.method === "GET") {
      const query = parsed.query || {};
      const type = typeof query.type === "string" ? query.type : "";

      let targetDir;
      if (type === "assets") {
        targetDir = path.join(SITE_DIR, "MEDIA");
      } else if (type === "clients") {
        targetDir = path.join(SITE_DIR, "MEDIA", "LOGOS_clients");
      } else {
        return sendJson(res, 400, { ok: false, error: "Invalid type. Use type=assets|clients" });
      }

      try {
        const entries = await fsp.readdir(targetDir, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

        return sendJson(res, 200, { ok: true, files });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "Failed to list media", details: String(e?.message || e) });
      }
    }

    if (pathname === "/api/contact" && req.method === "POST") {
      return handleContactPost(req, res);
    }

    // ADMIN: SHOP CATALOG (read/write)
    if (pathname === "/api/admin/shop/catalog" && req.method === "GET") {
      try {
        const catalog = await readShopCatalog();
        return sendJson(res, 200, { ok: true, catalog });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "Failed to read shop catalog", details: String(e?.message || e) });
      }
    }

    if (pathname === "/api/admin/shop/catalog" && req.method === "POST") {
      let raw = "";
      req.setEncoding("utf8");

      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 5_000_000) {
          res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Payload too large");
          req.destroy();
        }
      });

      req.on("end", async () => {
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
        }

        if (!payload || typeof payload !== "object") {
          return sendJson(res, 422, { ok: false, error: "Catalog JSON body must be an object" });
        }

        if (!Array.isArray(payload.items) || !Array.isArray(payload.categories)) {
          return sendJson(res, 422, { ok: false, error: "Catalog JSON must include items[] and categories[]" });
        }

        try {
          if (rtdb) {
            await rtdb.ref("shop_catalog").set(payload);
          } else {
            await fsp.writeFile(SHOP_CATALOG_PATH, JSON.stringify(payload, null, 2), "utf8");
          }
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: "Failed to write shop catalog", details: String(e?.message || e) });
        }
      });

      return;
    }

    // SHOP / PROFORMA API
    if (pathname === "/api/shop/catalog" && req.method === "GET") {
      try {
        const catalog = await readShopCatalog();
        return sendJson(res, 200, { ok: true, catalog });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "Failed to read shop catalog", details: String(e?.message || e) });
      }
    }

    if (pathname === "/api/shop/proforma" && req.method === "POST") {
      let raw = "";
      req.setEncoding("utf8");

      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 2_000_000) {
          res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Payload too large");
          req.destroy();
        }
      });

      req.on("end", async () => {
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
        }

        const customer = {
          name: typeof payload?.customer?.name === "string" ? payload.customer.name.trim() : "",
          email: typeof payload?.customer?.email === "string" ? payload.customer.email.trim() : "",
          phone: typeof payload?.customer?.phone === "string" ? payload.customer.phone.trim() : "",
        };

        const event = {
          eventType: typeof payload?.event?.eventType === "string" ? payload.event.eventType.trim() : "",
          location: typeof payload?.event?.location === "string" ? payload.event.location.trim() : "",
        };

        const daysNum = payload?.days;
        const days = Number(daysNum);
        const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(30, Math.floor(days))) : 1;

        const cart = Array.isArray(payload?.cart) ? payload.cart : [];

        if (!customer.name || !customer.email) {
          return sendJson(res, 422, { ok: false, error: "customer.name and customer.email are required" });
        }
        if (!cart.length) {
          return sendJson(res, 422, { ok: false, error: "cart is required (at least one item)" });
        }

        let catalog;
        try {
          catalog = await readShopCatalog();
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: "Failed to load shop catalog", details: String(e?.message || e) });
        }

        const itemById = new Map((catalog.items || []).map((it) => [it.id, it]));
        const categoryById = new Map((catalog.categories || []).map((c) => [c.id, c]));

        const lines = [];
        for (const ci of cart) {
          const id = typeof ci?.id === "string" ? ci.id : "";
          const qty = Number.isFinite(Number(ci?.qty)) ? Math.max(1, Math.floor(Number(ci.qty))) : 1;
          const it = itemById.get(id);
          if (!it) continue;

          const cat = categoryById.get(it.categoryId) || { label: it.categoryId };
          const pricePerDayRaw = it?.priceFcfaPerDay;
          const pricePerDay = Number.isFinite(Number(pricePerDayRaw)) ? Number(pricePerDayRaw) : Number(pricePerDayRaw);

          if (!Number.isFinite(pricePerDay)) continue;

          lines.push({
            id: it.id,
            title: it.title,
            kindLabel: it.kind === "technician" ? "Technicien" : "Matériel",
            categoryLabel: cat.label,
            kind: it.kind,
            qty,
            pricePerDay,
          });
        }

        if (!lines.length) {
          return sendJson(res, 422, { ok: false, error: "No valid cart items" });
        }

        const subtotal = lines.reduce((sum, l) => sum + l.pricePerDay * l.qty, 0);
        const total = subtotal * safeDays;

        const proformaNo =
          "PRO-" +
          new Date().toISOString().slice(0, 10).replaceAll("-", "") +
          "-" +
          Math.random().toString(16).slice(2, 8).toUpperCase();

        const currencyLabel = catalog?.meta?.currencyLabel || "FCFA";

        const html = buildProformaHtml({
          proformaNo,
          customer,
          event,
          days: safeDays,
          lines,
          totals: { subtotal, total },
          currencyLabel,
        });

        const subject = `Proforma location ${proformaNo} — Total ${formatMoney(total, currencyLabel)}`;

        const record = {
          id: proformaNo,
          at: new Date().toISOString(),
          customer,
          event,
          days: safeDays,
          cart: cart.map((x) => ({ id: x?.id, qty: x?.qty })),
          totals: { subtotal, total },
        };

        await appendProformaLog(record);

        const resendApiKey = process.env.RESEND_API_KEY || "";
        const resendFrom = process.env.RESEND_FROM || "noreply@gabaoindex.com";
        const adminTo = process.env.SHOP_ADMIN_EMAIL || "admin@gmail.com";

        if (!resendApiKey) {
          return sendJson(res, 503, {
            ok: false,
            error: "Resend API key missing. Set RESEND_API_KEY env var.",
            proformaNo,
            totalFcfa: total,
            currency: currencyLabel,
            subtotalFcfa: subtotal,
          });
        }

        try {
          await sendWithResend({
            apiKey: resendApiKey,
            from: resendFrom,
            to: customer.email,
            subject,
            html,
          });

          await sendWithResend({
            apiKey: resendApiKey,
            from: resendFrom,
            to: adminTo,
            subject,
            html,
          });
        } catch (e) {
          return sendJson(res, 500, {
            ok: false,
            error: "Failed to send proforma email",
            details: String(e?.message || e),
            proformaNo,
          });
        }

        return sendJson(res, 200, { ok: true, proformaNo, totalFcfa: total, currency: currencyLabel });
      });

      return;
    }

    // Default: serve static files under ossprogroup/ with URL prefix:
    // - /ossprogroup/ -> index.html
    // - /ossprogroup/admin -> ossprogroup-admin.html
    // - /ossprogroup/solutions -> solutions landing
    // - /ossprogroup/solutions/perenco -> dedicated event page
    // - others -> static files under ossprogroup/
    //
    // Also supports legacy paths without the /ossprogroup prefix.
    const OSS_PREFIX = "/ossprogroup";
    let staticPath = pathname;

    if (staticPath === OSS_PREFIX) staticPath = "/";
    if (staticPath.startsWith(OSS_PREFIX + "/")) {
      staticPath = staticPath.slice(OSS_PREFIX.length); // keep leading '/'
    }

    let fileRel;
    if (staticPath === "/" || staticPath === "") fileRel = "index.html";
    else if (staticPath === "/admin") fileRel = "ossprogroup-admin.html";
    else if (staticPath === "/solutions") fileRel = "solutions.html";
    else if (staticPath === "/solutions/perenco") fileRel = "ossprogroup-solution-perenco.html";
    else if (staticPath.startsWith("/")) fileRel = staticPath;

    if (!fileRel) return sendText(res, 404, "Not found");

    const filePath = safeJoin(SITE_DIR, fileRel);

    // Prevent serving outside the directory
    if (!filePath.startsWith(SITE_DIR)) {
      return sendText(res, 403, "Forbidden");
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return sendText(res, 404, "Not found");
    }

    if (stat.isDirectory()) {
      return sendText(res, 404, "Not found");
    }

    const mime = guessMime(filePath);
    const isAsset = /\.(png|jpe?g|avif|webp|svg|ico|css|js)$/i.test(filePath);
    const cache = isAsset ? "public, max-age=31536000, immutable" : "no-store";

    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": cache,
      "Content-Length": stat.size,
    });

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => sendText(res, 500, "Read error"));
    stream.pipe(res);
  } catch (e) {
    sendText(res, 500, "Server error: " + String(e?.message || e));
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`OSSPROGROUP server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Site: http://localhost:${PORT}/`);
  // eslint-disable-next-line no-console
  console.log(`Admin: http://localhost:${PORT}/admin`);
});
