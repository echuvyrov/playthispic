import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBeatportAuth } from "../server/beatport-auth.mjs";

const env = { BEATPORT_CLIENT_ID: "our-test-app", BEATPORT_CLIENT_SECRET: "test-secret", BEATPORT_REDIRECT_URI: "http://127.0.0.1:5174/auth/beatport/callback" };
const token = () => new Response(JSON.stringify({ access_token: "private-access-token", refresh_token: "private-refresh-token", token_type: "Bearer", expires_in: 60 }));
async function request(handler, path, { cookie, method = "GET", origin, host = "127.0.0.1:5174" } = {}) {
  const response = { headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body = "") { this.body = body; } };
  await handler({ url: path, method, headers: { cookie, origin, host } }, response);
  return response;
}
async function start(handler) {
  const response = await request(handler, "/auth/beatport/start");
  return { response, cookie: response.headers["Set-Cookie"].split(";")[0], location: new URL(response.headers.Location) };
}
const callback = (state) => `/auth/beatport/callback?code=test-code&state=${encodeURIComponent(state)}`;

test("missing registration never simulates a connected account", async () => {
  const handler = createBeatportAuth({ env: {} });
  const status = await request(handler, "/api/beatport/status");
  assert.equal(JSON.parse(status.body).configured, false);
  assert.equal(JSON.parse(status.body).connected, false);
  assert.equal((await request(handler, "/auth/beatport/start")).status, 503);
});

test("authorization uses registered client, state, PKCE and private cookie; tokens stay server-side", async () => {
  let sent;
  const handler = createBeatportAuth({ env, fetchImpl: async (url, options) => { sent = { url, body: options.body }; return token(); } });
  const login = await start(handler);
  assert.match(login.response.headers["Set-Cookie"], /HttpOnly; SameSite=Lax/);
  assert.equal(login.location.origin, "https://api.beatport.com");
  assert.equal(login.location.searchParams.get("client_id"), env.BEATPORT_CLIENT_ID);
  assert.equal(login.location.searchParams.get("redirect_uri"), env.BEATPORT_REDIRECT_URI);
  assert.equal(login.location.searchParams.has("client_secret"), false);
  const result = await request(handler, callback(login.location.searchParams.get("state")), login);
  assert.match(result.body, /Beatport connected/);
  assert.equal(sent.body.get("client_secret"), env.BEATPORT_CLIENT_SECRET);
  const challenge = createHash("sha256").update(sent.body.get("code_verifier")).digest("base64url");
  assert.equal(challenge, login.location.searchParams.get("code_challenge"));
  const status = await request(handler, "/api/beatport/status", login);
  assert.equal(JSON.parse(status.body).connected, true);
  assert.doesNotMatch(result.body + status.body, /private-access-token|private-refresh-token|test-secret/);
});

test("missing session, wrong state and replayed callbacks never exchange codes", async () => {
  let calls = 0;
  const handler = createBeatportAuth({ env, fetchImpl: async () => { calls++; return token(); } });
  const login = await start(handler);
  const path = callback(login.location.searchParams.get("state"));
  await request(handler, path);
  await request(handler, callback("wrong-state"), login);
  assert.equal(calls, 0);
  await request(handler, path, login);
  await request(handler, path, login);
  assert.equal(calls, 1);
});

test("expired and denied sign-ins cannot complete", async () => {
  let clock = 0;
  let calls = 0;
  const handler = createBeatportAuth({ env, now: () => clock, fetchImpl: async () => { calls++; return token(); } });
  const expired = await start(handler);
  clock = 11 * 60 * 1000;
  await request(handler, callback(expired.location.searchParams.get("state")), expired);
  const denied = await start(handler);
  const state = denied.location.searchParams.get("state");
  await request(handler, `/auth/beatport/callback?error=access_denied&state=${state}`, denied);
  await request(handler, callback(state), denied);
  assert.equal(calls, 0);
});

test("failed token exchange returns a safe failure without marking connected", async () => {
  const handler = createBeatportAuth({ env, fetchImpl: async () => new Response("private-provider-error", { status: 401 }) });
  const login = await start(handler);
  const result = await request(handler, callback(login.location.searchParams.get("state")), login);
  assert.match(result.body, /did not complete/);
  assert.doesNotMatch(result.body, /private-provider-error/);
  assert.equal(JSON.parse((await request(handler, "/api/beatport/status", login)).body).connected, false);
});

test("expired access token is refreshed without exposing it", async () => {
  let clock = 0;
  let grant;
  const handler = createBeatportAuth({ env, now: () => clock, fetchImpl: async (_url, options) => { grant = options.body.get("grant_type"); return token(); } });
  const login = await start(handler);
  await request(handler, callback(login.location.searchParams.get("state")), login);
  clock = 61000;
  assert.equal(JSON.parse((await request(handler, "/api/beatport/status", login)).body).connected, true);
  assert.equal(grant, "refresh_token");
});

test("disconnect requires same-origin POST and removes the local connection", async () => {
  const handler = createBeatportAuth({ env, fetchImpl: async () => token() });
  const login = await start(handler);
  await request(handler, callback(login.location.searchParams.get("state")), login);
  assert.equal((await request(handler, "/api/beatport/disconnect", { ...login, method: "POST", origin: "https://other.example" })).status, 403);
  assert.equal(JSON.parse((await request(handler, "/api/beatport/status", login)).body).connected, true);
  const disconnected = await request(handler, "/api/beatport/disconnect", { ...login, method: "POST", origin: "http://127.0.0.1:5174" });
  assert.match(disconnected.headers["Set-Cookie"], /Max-Age=0/);
  assert.equal(JSON.parse((await request(handler, "/api/beatport/status", login)).body).connected, false);
});

test("production redirect requires HTTPS and uses a Secure cookie", async () => {
  assert.throws(() => createBeatportAuth({ env: { ...env, BEATPORT_REDIRECT_URI: "http://example.com/auth/beatport/callback" } }));
  const handler = createBeatportAuth({ env: { ...env, BEATPORT_REDIRECT_URI: "https://example.com/auth/beatport/callback" } });
  const response = await request(handler, "/auth/beatport/start", { host: "example.com" });
  assert.match(response.headers["Set-Cookie"], /; Secure/);
});
