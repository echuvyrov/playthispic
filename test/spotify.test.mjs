import test from "node:test";
import assert from "node:assert/strict";
import { createSpotifyIntegration } from "../server/spotify.mjs";

const env = { SPOTIFY_CLIENT_ID: "spotify-client", SPOTIFY_REDIRECT_URI: "http://127.0.0.1:5174/auth/spotify/callback" };
const token = () => new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 }));
async function request(handler, path, { cookie, method = "GET", origin, body = "", host = "127.0.0.1:5174" } = {}) {
  const response = { headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body = "") { this.body = body; } };
  await handler({ url: path, method, headers: { cookie, origin, host }, async *[Symbol.asyncIterator]() { if (body) yield body; } }, response);
  return response;
}

test("Spotify setup reports disabled until a client ID exists", async () => {
  const handler = createSpotifyIntegration({ env: {} });
  const status = await request(handler, "/api/spotify/status");
  assert.deepEqual(JSON.parse(status.body), { configured: false, connected: false, message: "Add SPOTIFY_CLIENT_ID to .env to enable Spotify." });
  assert.equal((await request(handler, "/auth/spotify/start")).status, 503);
});

test("Spotify PKCE callback stores token privately", async () => {
  let calls = [];
  const handler = createSpotifyIntegration({ env, fetchImpl: async (url, options) => { calls.push({ url, body: options.body }); return token(); } });
  const start = await request(handler, "/auth/spotify/start");
  const cookie = start.headers["Set-Cookie"].split(";")[0];
  const auth = new URL(start.headers.Location);
  assert.equal(auth.searchParams.get("client_id"), env.SPOTIFY_CLIENT_ID);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  const callback = await request(handler, `/auth/spotify/callback?code=code&state=${auth.searchParams.get("state")}`, { cookie });
  assert.match(callback.body, /Spotify connected/);
  assert.equal(JSON.parse((await request(handler, "/api/spotify/status", { cookie })).body).connected, true);
  assert.doesNotMatch(callback.body, /access|refresh/);
  assert.equal(calls[0].body.get("code_verifier")?.length > 20, true);
});

test("Spotify search returns track candidates and playlist endpoint creates in order", async () => {
  const searches = [];
  const handler = createSpotifyIntegration({ env, fetchImpl: async (url) => {
    if (url.includes("/api/token")) return token();
    if (url.endsWith("/me")) return new Response(JSON.stringify({ id: "user", display_name: "DJ" }));
    if (url.includes("/search?")) { searches.push(url); return new Response(JSON.stringify({ tracks: { items: [{ id: "abc", uri: "spotify:track:abc", name: "Glue", artists: [{ name: "Bicep" }], album: { name: "Bicep" }, external_urls: { spotify: "https://open.spotify.com/track/abc" } }] } })); }
    if (url.endsWith("/me/playlists")) return new Response(JSON.stringify({ id: "playlist", external_urls: { spotify: "https://open.spotify.com/playlist/playlist" } }));
    if (url.includes("/playlists/playlist/items")) return new Response(JSON.stringify({ snapshot_id: "snap" }));
    throw new Error(`unexpected ${url}`);
  } });
  const start = await request(handler, "/auth/spotify/start");
  const cookie = start.headers["Set-Cookie"].split(";")[0];
  const auth = new URL(start.headers.Location);
  await request(handler, `/auth/spotify/callback?code=code&state=${auth.searchParams.get("state")}`, { cookie });
  const matches = await request(handler, "/api/spotify/search", { method: "POST", cookie, body: JSON.stringify({ tracks: [{ id: "row-1", artist: "Bicep", title: "Glue" }] }) });
  assert.equal(JSON.parse(matches.body).matches[0].candidates[0].uri, "spotify:track:abc");
  assert.equal(searches.length, 1, "the broad passes are bounded once a precise result is found");
  const playlist = await request(handler, "/api/spotify/create-playlist", { method: "POST", cookie, origin: "http://127.0.0.1:5174", body: JSON.stringify({ name: "Chart", public: false, uris: ["spotify:track:abc"] }) });
  assert.equal(playlist.status, 201);
  assert.equal(JSON.parse(playlist.body).count, 1);
});

test("Spotify search broadens after an OCR typo and fuzzy-ranks the recovered artist", async () => {
  let searchCount = 0;
  const handler = createSpotifyIntegration({ env, fetchImpl: async (url) => {
    if (url.includes("/api/token")) return token();
    if (url.endsWith("/me")) return new Response(JSON.stringify({ id: "user" }));
    if (url.includes("/search?")) {
      searchCount++;
      if (searchCount === 1) return new Response(JSON.stringify({ tracks: { items: [] } }));
      return new Response(JSON.stringify({ tracks: { items: [{ id: "gom", uri: "spotify:track:gom", name: "Wo, Man", artists: [{ name: "Peggy Gou" }], album: { name: "I Hear You" }, external_urls: { spotify: "https://open.spotify.com/track/gom" } }] } }));
    }
    throw new Error(`unexpected ${url}`);
  } });
  const start = await request(handler, "/auth/spotify/start");
  const cookie = start.headers["Set-Cookie"].split(";")[0];
  const auth = new URL(start.headers.Location);
  await request(handler, `/auth/spotify/callback?code=code&state=${auth.searchParams.get("state")}`, { cookie });
  const matches = await request(handler, "/api/spotify/search", { method: "POST", cookie, body: JSON.stringify({ tracks: [{ id: "row-1", artist: "Peggy Wou", title: "Wo, Man" }] }) });
  const candidate = JSON.parse(matches.body).matches[0].candidates[0];
  assert.equal(candidate.artist, "Peggy Gou");
  assert.ok(candidate.score >= 80);
  assert.equal(searchCount, 2);
});

test("tentative playlist can be created empty, then updated with a track", async () => {
  const calls = [];
  const handler = createSpotifyIntegration({ env, fetchImpl: async (url, options) => {
    calls.push({ url, body: options?.body instanceof URLSearchParams ? Object.fromEntries(options.body) : options?.body && JSON.parse(options.body) });
    if (url.includes("/api/token")) return token();
    if (url.endsWith("/me")) return new Response(JSON.stringify({ id: "user" }));
    if (url.endsWith("/me/playlists")) return new Response(JSON.stringify({ id: "tentative", external_urls: { spotify: "https://open.spotify.com/playlist/tentative" } }));
    return new Response(JSON.stringify({ snapshot_id: "snap" }));
  } });
  const start = await request(handler, "/auth/spotify/start");
  const cookie = start.headers["Set-Cookie"].split(";")[0];
  const auth = new URL(start.headers.Location);
  await request(handler, `/auth/spotify/callback?code=code&state=${auth.searchParams.get("state")}`, { cookie });
  const empty = await request(handler, "/api/spotify/create-playlist", { method: "POST", cookie, origin: "http://127.0.0.1:5174", body: JSON.stringify({ tentative: true, name: "Living" }) });
  assert.equal(empty.status, 201);
  const added = await request(handler, "/api/spotify/create-playlist", { method: "POST", cookie, origin: "http://127.0.0.1:5174", body: JSON.stringify({ playlistId: "tentative", uris: ["spotify:track:abc"] }) });
  assert.equal(added.status, 201);
  assert.deepEqual(calls.at(-1).body, { uris: ["spotify:track:abc"] });
});

test("Spotify callbacks reject mismatched state and playlist requests require a session", async () => {
  const handler = createSpotifyIntegration({ env, fetchImpl: async () => token() });
  const start = await request(handler, "/auth/spotify/start");
  const cookie = start.headers["Set-Cookie"].split(";")[0];
  assert.match((await request(handler, "/auth/spotify/callback?code=code&state=wrong", { cookie })).body, /did not complete/);
  const response = await request(handler, "/api/spotify/create-playlist", { method: "POST", body: JSON.stringify({ uris: ["spotify:track:x"] }) });
  assert.equal(response.status, 401);
});
