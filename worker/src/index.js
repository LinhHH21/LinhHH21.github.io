// Portfolio likes: counts likes in KV and sends a Telegram message for each new like
// and for the optional name/message a visitor leaves afterwards.
//
// Bindings / settings (Cloudflare dashboard or wrangler.toml):
//   LIKES               KV namespace
//   ALLOWED_ORIGINS     comma-separated origins allowed to call the API
//   TELEGRAM_BOT_TOKEN  secret – bot token from @BotFather
//   TELEGRAM_CHAT_ID    secret – your chat id
//   IP_SALT             secret (optional) – salt for hashing visitor IPs (raw IPs are never stored)

const LIKES_PER_IP_PER_DAY = 5;
const NOTES_PER_IP_PER_DAY = 3;
const ALERTS_PER_DAY = 300;
const VISITOR_TTL = 60 * 60 * 24 * 400; // remember a visitor's like for ~13 months
const DAY_TTL = 60 * 60 * 48;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

    const { pathname } = new URL(req.url);
    try {
      if (req.method === "GET" && pathname === "/likes") {
        return json({ count: await getCount(env) });
      }
      if (req.method === "POST" && (pathname === "/like" || pathname === "/note")) {
        if (!cors["Access-Control-Allow-Origin"]) return json({ error: "forbidden" }, 403);
        const body = await req.json().catch(() => null);
        const vid = body && typeof body.vid === "string" ? body.vid : "";
        if (!/^[0-9a-f-]{36}$/i.test(vid)) return json({ error: "bad_request" }, 400);
        const ipHash = await hashIp(req, env);
        return pathname === "/like"
          ? await like(req, env, ctx, json, vid, ipHash, body)
          : await note(env, ctx, json, vid, ipHash, body);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "server_error" }, 500);
    }
  },
};

async function like(req, env, ctx, json, vid, ipHash, body) {
  const vkey = "v:" + vid;
  if (await env.LIKES.get(vkey)) return json({ count: await getCount(env), already: true });
  if (!(await allow(env, "like", ipHash, LIKES_PER_IP_PER_DAY))) return json({ error: "rate_limited" }, 429);

  const count = (await getCount(env)) + 1;
  await env.LIKES.put("count", String(count));
  await env.LIKES.put(vkey, JSON.stringify({ n: count, t: Date.now() }), { expirationTtl: VISITOR_TTL });

  const cf = req.cf || {};
  const place = [cf.city, cf.country].filter(Boolean).join(", ") || "không rõ";
  const text = [
    `❤️ Like mới #${count} cho portfolio`,
    `🕒 ${vnTime()}`,
    `📍 ${place}`,
    `🔗 Đến từ: ${refHost(body.ref)}`,
    `📱 ${device(req.headers.get("User-Agent") || "")}`,
  ].join("\n");
  ctx.waitUntil(notify(env, text));
  return json({ count });
}

async function note(env, ctx, json, vid, ipHash, body) {
  const vkey = "v:" + vid;
  const visitor = await env.LIKES.get(vkey, "json");
  if (!visitor) return json({ error: "like_first" }, 400);
  if (visitor.note) return json({ ok: true, already: true });

  const name = clean(body.name, 60);
  const message = clean(body.message, 500);
  if (!name && !message) return json({ error: "empty" }, 400);
  if (!(await allow(env, "note", ipHash, NOTES_PER_IP_PER_DAY))) return json({ error: "rate_limited" }, 429);

  visitor.note = true;
  await env.LIKES.put(vkey, JSON.stringify(visitor), { expirationTtl: VISITOR_TTL });

  const lines = [`💬 Lời nhắn kèm like #${visitor.n}`];
  if (name) lines.push(`👤 ${name}`);
  if (message) lines.push(`📝 ${message}`);
  ctx.waitUntil(notify(env, lines.join("\n")));
  return json({ ok: true });
}

async function getCount(env) {
  return parseInt((await env.LIKES.get("count")) || "0", 10) || 0;
}

// Simple per-day counter; KV is eventually consistent, which is fine for spam limits.
async function allow(env, kind, who, max) {
  const key = `rl:${kind}:${new Date().toISOString().slice(0, 10)}:${who}`;
  const used = parseInt((await env.LIKES.get(key)) || "0", 10) || 0;
  if (used >= max) return false;
  await env.LIKES.put(key, String(used + 1), { expirationTtl: DAY_TTL });
  return true;
}

async function hashIp(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const data = new TextEncoder().encode((env.IP_SALT || "portfolio-likes") + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  if (!(await allow(env, "alert", "all", ALERTS_PER_DAY))) return;
  const api = env.TELEGRAM_API || "https://api.telegram.org";
  const res = await fetch(`${api}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) console.error("telegram", res.status, await res.text());
}

function clean(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max)
    : "";
}

// "26/11/2026 14:05" in Vietnam time
function vnTime() {
  const parts = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

function refHost(ref) {
  if (typeof ref !== "string" || !ref) return "mở trực tiếp";
  try {
    return new URL(ref).hostname.replace(/^www\./, "") || "mở trực tiếp";
  } catch {
    return "không rõ";
  }
}

function device(ua) {
  const kind = /iPad|Tablet/i.test(ua) ? "Máy tính bảng" : /Mobi|Android|iPhone/i.test(ua) ? "Điện thoại" : "Máy tính";
  const app = /Zalo/i.test(ua) ? "Zalo"
    : /FBAN|FBAV|FB_IAB/i.test(ua) ? "Facebook app"
    : /LinkedInApp/i.test(ua) ? "LinkedIn app"
    : /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /CocCoc/i.test(ua) ? "Cốc Cốc"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "trình duyệt khác";
  return `${kind} · ${app}`;
}
