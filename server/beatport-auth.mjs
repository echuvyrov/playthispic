import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const authorizeUrl = "https://api.beatport.com/v4/auth/o/authorize/";
const tokenUrl = "https://api.beatport.com/v4/auth/o/token/";
const random = () => randomBytes(32).toString("base64url");
const same = (a, b) => typeof a === "string" && typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createBeatportAuth({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const sessions = new Map();
  const redirect = new URL(env.BEATPORT_REDIRECT_URI || `http://127.0.0.1:${env.PORT || 5174}/auth/beatport/callback`);
  if (redirect.pathname !== "/auth/beatport/callback" || redirect.search || redirect.hash ||
      redirect.username || redirect.password ||
      (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname)))) {
    throw new Error("BEATPORT_REDIRECT_URI must be an HTTPS URL (or local HTTP) ending in /auth/beatport/callback.");
  }
  const configured = Boolean(env.BEATPORT_CLIENT_ID?.trim());
  const cookie = (id, maxAge = 28800) => `ptp_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${redirect.protocol === "https:" ? "; Secure" : ""}`;
  const json = (response, status, data) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  };
  const getSession = (request) => {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
    const id = request.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith("ptp_session="))?.slice(12);
    return [id, sessions.get(id)];
  };
  const saveToken = (session, token) => {
    if (typeof token.access_token !== "string" || !token.access_token ||
        !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0 ||
        token.token_type?.toLowerCase() !== "bearer") throw new Error("Invalid token response");
    session.token = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || session.token?.refreshToken,
      expiresAt: now() + Number(token.expires_in) * 1000
    };
  };
  const exchange = async (values) => {
    const body = new URLSearchParams({ client_id: env.BEATPORT_CLIENT_ID, ...values });
    if (env.BEATPORT_CLIENT_SECRET) body.set("client_secret", env.BEATPORT_CLIENT_SECRET);
    const response = await fetchImpl(tokenUrl, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body, signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error("Beatport token exchange failed");
    return response.json();
  };
  const finish = (response, success) => {
    const nonce = random();
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`
    });
    response.end(`<!doctype html><html><head><title>Beatport connection</title></head><body>
      <h1>${success ? "Beatport connected" : "Beatport connection did not complete"}</h1>
      <p>${success ? "You can return to your tracklist." : "Return to PlayThisPic and try connecting again."}</p>
      <a href="/">Return to PlayThisPic</a>
      <script nonce="${nonce}">if(window.opener){window.opener.postMessage({type:"beatport-auth",success:${success}},location.origin);window.close();}</script>
      </body></html>`);
  };

  return async function handleBeatport(request, response) {
    const url = new URL(request.url, redirect.origin);
    if (!["/api/beatport/status", "/auth/beatport/start", "/auth/beatport/callback", "/api/beatport/disconnect"].includes(url.pathname)) return false;
    const [id, session] = getSession(request);
    if (url.pathname === "/api/beatport/status" && request.method === "GET") {
      if (session?.token && session.token.expiresAt <= now()) {
        if (session.token.refreshToken) {
          session.refreshing ||= exchange({ grant_type: "refresh_token", refresh_token: session.token.refreshToken })
            .then((token) => saveToken(session, token)).catch(() => { delete session.token; })
            .finally(() => { delete session.refreshing; });
          await session.refreshing;
        } else delete session.token;
      }
      json(response, 200, { configured, connected: Boolean(session?.token), message: configured
        ? "Sign in on Beatport to connect your account."
        : "Beatport connection is not available yet. You can still review and export your tracks." });
    } else if (url.pathname === "/auth/beatport/start" && request.method === "GET") {
      if (!configured) { json(response, 503, { error: "Beatport app registration is not configured." }); return true; }
      if (request.headers.host !== redirect.host) { json(response, 400, { error: `Open PlayThisPic at ${redirect.origin} before connecting.` }); return true; }
      const sessionId = random();
      const state = random();
      const verifier = random();
      // Rotate the local session ID for each sign-in, keeping any existing login until success.
      if (id) sessions.delete(id);
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionId, { token: session?.token, expiresAt: now() + 8 * 60 * 60 * 1000,
        pending: { state, verifier, expiresAt: now() + 10 * 60 * 1000 } });
      const location = new URL(authorizeUrl);
      location.search = new URLSearchParams({ client_id: env.BEATPORT_CLIENT_ID, response_type: "code",
        redirect_uri: redirect.href, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      if (env.BEATPORT_SCOPES?.trim()) location.searchParams.set("scope", env.BEATPORT_SCOPES.trim());
      response.writeHead(302, { Location: location.href, "Set-Cookie": cookie(sessionId), "Cache-Control": "no-store" });
      response.end();
    } else if (url.pathname === "/auth/beatport/callback" && request.method === "GET") {
      const pending = session?.pending;
      if (!pending || pending.expiresAt <= now() || !same(pending.state, url.searchParams.get("state"))) {
        finish(response, false); return true;
      }
      delete session.pending; // A callback can be used only once, including denied requests.
      if (url.searchParams.has("error") || !url.searchParams.get("code")) { finish(response, false); return true; }
      try {
        saveToken(session, await exchange({ grant_type: "authorization_code", code: url.searchParams.get("code"),
          redirect_uri: redirect.href, code_verifier: pending.verifier }));
        finish(response, true);
      } catch {
        finish(response, false);
      }
    } else if (url.pathname === "/api/beatport/disconnect" && request.method === "POST") {
      if (request.headers.origin !== redirect.origin) { json(response, 403, { error: "Invalid request origin." }); return true; }
      if (id) sessions.delete(id);
      response.setHeader("Set-Cookie", cookie("", 0));
      json(response, 200, { connected: false });
    } else json(response, 405, { error: "Method not allowed." });
    return true;
  };
}
