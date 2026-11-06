const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const randomId = (bytes = 16) => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
};

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function verifySession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)sp_session=([^;]+)/);
  if (!match || !env.ADMIN_PASSWORD) return false;
  const [expires, signature] = match[1].split(".");
  if (!expires || Number(expires) < Date.now()) return false;
  return (await sign(expires, env.ADMIN_PASSWORD)) === signature;
}

function cookieHeader(value, maxAge) {
  return \`sp_session=\${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=\${maxAge}\`;
}

function safeName(name) {
  return (name || "file").replace(/[\\\\/\\\\?%*:|"<>\\x00-\\x1F]/g, "_").slice(0, 180);
}

async function cleanupExpired(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM orders WHERE expires_at <= ?"
  ).bind(new Date().toISOString()).all();
  for (const order of results || []) {
    const { results: files } = await env.DB.prepare("SELECT r2_key FROM files WHERE order_id = ?").bind(order.id).all();
    for (const file of files || []) await env.FILES.delete(file.r2_key);
    await env.DB.prepare("DELETE FROM orders WHERE id = ?").bind(order.id).run();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": url.origin,
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Upload-Token",
      }});
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/s/"))) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), request));
    }
    if (method === "GET" && url.pathname === "/admin") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", url.origin), request));
    }
    if (method === "GET" && url.pathname === "/health") return json({ ok: true, app: "Scan & Print" });

    if (method === "POST" && url.pathname === "/api/login") {
      const body = await request.json().catch(() => ({}));
      if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) return json({ error: "Wrong password" }, 401);
      const expires = String(Date.now() + 12 * 60 * 60 * 1000);
      const value = \`\${expires}.\${await sign(expires, env.ADMIN_PASSWORD)}\`;
      return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(value, 43200) });
    }

    if (method === "POST" && url.pathname === "/api/logout") {
      return json({ ok: true }, 200, { "Set-Cookie": cookieHeader("", 0) });
    }

    if (method === "POST" && url.pathname === "/api/orders") {
      const body = await request.json().catch(() => ({}));
      const slug = env.SHOP_SLUG || "pilot-shop";
      if (body.shopSlug && body.shopSlug !== slug) return json({ error: "This shop link is not valid." }, 404);
      const id = randomId(8);
      const uploadToken = randomId(24);
      const retention = Math.max(1, Number(env.FILE_RETENTION_HOURS || 24));
      const expiresAt = new Date(Date.now() + retention * 3600000).toISOString();
      await env.DB.prepare(
        "INSERT INTO orders (id, shop_slug, upload_token_hash, expires_at) VALUES (?, ?, ?, ?)"
      ).bind(id, slug, await sha256(uploadToken), expiresAt).run();
      return json({ orderId: id, uploadToken, expiresAt });
    }

    const uploadMatch = url.pathname.match(/^\\/api\\/orders\\/([a-f0-9]+)\\/files$/);
    if (method === "POST" && uploadMatch) {
      const orderId = uploadMatch[1];
      const token = request.headers.get("X-Upload-Token") || "";
      const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
      if (!order || order.expires_at <= new Date().toISOString() ||
          !(await sha256(token)) || await sha256(token) !== order.upload_token_hash) {
        return json({ error: "Upload session expired. Please scan the QR code again." }, 401);
      }
      const fileName = safeName(decodeURIComponent(request.headers.get("X-File-Name") || "upload"));
      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      const declaredSize = Number(request.headers.get("X-File-Size") || 0);
      const maxOrderBytes = Number(env.MAX_ORDER_BYTES || 524288000);
      if (!declaredSize || declaredSize > 250 * 1024 * 1024) return json({ error: "Each file must be smaller than 250 MB." }, 413);
      if (order.total_bytes + declaredSize > maxOrderBytes) return json({ error: "This order has reached the temporary upload capacity. Please split it into two orders." }, 413);
      const fileId = randomId(12);
      const key = \`orders/\${orderId}/\${fileId}-\${fileName}\`;
      await env.FILES.put(key, request.body, { httpMetadata: { contentType } });
      await env.DB.prepare(
        "INSERT INTO files (id, order_id, original_name, content_type, size_bytes, r2_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(fileId, orderId, fileName, contentType, declaredSize, key).run();
      await env.DB.prepare(
        "UPDATE orders SET total_bytes = total_bytes + ?, file_count = file_count + 1 WHERE id = ?"
      ).bind(declaredSize, orderId).run();
      return json({ ok: true, fileId, name: fileName });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!(await verifySession(request, env))) return json({ error: "Please log in again." }, 401);
      if (method === "GET" && url.pathname === "/api/admin/orders") {
        await cleanupExpired(env);
        const { results } = await env.DB.prepare(
          "SELECT id, status, created_at, expires_at, total_bytes, file_count FROM orders WHERE shop_slug = ? ORDER BY created_at DESC LIMIT 100"
        ).bind(env.SHOP_SLUG || "pilot-shop").all();
        return json({ orders: results || [] });
      }
      const filesMatch = url.pathname.match(/^\\/api\\/admin\\/orders\\/([a-f0-9]+)\\/files$/);
      if (method === "GET" && filesMatch) {
        const { results } = await env.DB.prepare(
          "SELECT id, original_name, content_type, size_bytes FROM files WHERE order_id = ? ORDER BY created_at"
        ).bind(filesMatch[1]).all();
        return json({ files: results || [] });
      }
      const downloadMatch = url.pathname.match(/^\\/api\\/admin\\/files\\/([a-f0-9]+)$/);
      if (method === "GET" && downloadMatch) {
        const file = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(downloadMatch[1]).first();
        if (!file) return json({ error: "File not found or expired." }, 404);
        const object = await env.FILES.get(file.r2_key);
        if (!object) return json({ error: "File not found or expired." }, 404);
        return new Response(object.body, { headers: {
          "Content-Type": file.content_type,
          "Content-Disposition": \`inline; filename*=UTF-8''\${encodeURIComponent(file.original_name)}\`,
          "Cache-Control": "private, no-store",
        }});
      }
      const statusMatch = url.pathname.match(/^\\/api\\/admin\\/orders\\/([a-f0-9]+)\\/complete$/);
      if (method === "POST" && statusMatch) {
        await env.DB.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").bind(statusMatch[1]).run();
        return json({ ok: true });
      }
    }
    return json({ error: "Not found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
};
