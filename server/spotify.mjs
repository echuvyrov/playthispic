import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const authorizeUrl = "https://accounts.spotify.com/authorize";
const tokenUrl = "https://accounts.spotify.com/api/token";
const apiUrl = "https://api.spotify.com/v1";
const random = () => randomBytes(32).toString("base64url");
const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normalize = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const levenshtein = (left, right) => {
  const a = normalize(left), b = normalize(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]; previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
};
const similarity = (left, right) => {
  const a = normalize(left), b = normalize(right);
  return !a || !b ? 0 : Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
};

export function createSpotifyIntegration({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const sessions = new Map();
  const port = env.PORT || 5174;
  const redirect = new URL(env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${port}/auth/spotify/callback`);
  if (redirect.pathname !== "/auth/spotify/callback" || redirect.search || redirect.hash || redirect.username || redirect.password ||
      (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(redirect.hostname)))) {
    throw new Error("SPOTIFY_REDIRECT_URI must be HTTPS (or a loopback HTTP URL) ending in /auth/spotify/callback.");
  }
  const configured = Boolean(env.SPOTIFY_CLIENT_ID?.trim());
  const cookie = (id, maxAge = 28800) => `ptp_spotify_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${redirect.protocol === "https:" ? "; Secure" : ""}`;
  const json = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  const sessionFrom = (req) => {
    for (const [id, item] of sessions) if (item.expiresAt <= now()) sessions.delete(id);
    const id = req.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith("ptp_spotify_session="))?.slice(20);
    return [id, sessions.get(id)];
  };
  const saveToken = (session, token) => {
    if (!token?.access_token || !Number(token.expires_in)) throw new Error("Invalid Spotify token response.");
    session.token = { accessToken: token.access_token, refreshToken: token.refresh_token || session.token?.refreshToken, expiresAt: now() + Number(token.expires_in) * 1000 };
  };
  const tokenRequest = async (params) => {
    const response = await fetchImpl(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.SPOTIFY_CLIENT_ID, ...params }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error("Spotify token exchange failed.");
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };
  const finish = (res, ok) => {
    const nonce = random();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'` });
    res.end(`<!doctype html><html><head><title>Spotify connection</title></head><body><h1>${ok ? "Spotify connected" : "Spotify connection did not complete"}</h1><p>${ok ? "Returning to PlayThisPic…" : "Returning to PlayThisPic…"}</p><a href="/">Return to PlayThisPic</a><script nonce="${nonce}">if(window.opener){window.opener.postMessage({type:"spotify-auth",success:${ok}},location.origin);window.close();}else{location.replace("/?spotify=${ok ? "success" : "cancelled"}");}</script></body></html>`);
  };
  const spotifyFetch = async (session, path, options = {}) => {
    if (!session?.token) throw Object.assign(new Error("Connect Spotify before using Spotify features."), { status: 401 });
    if (session.token.expiresAt <= now() && session.token.refreshToken) saveToken(session, await tokenRequest({ grant_type: "refresh_token", refresh_token: session.token.refreshToken }));
    const response = await fetchImpl(`${apiUrl}${path}`, { ...options, headers: { Authorization: `Bearer ${session.token.accessToken}`, ...(options.headers || {}) }, signal: options.signal || AbortSignal.timeout(20000) });
    if (!response.ok) {
      const error = new Error(`Spotify API request failed (${response.status}).`); error.status = response.status; throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };

  return async function handleSpotify(req, res) {
    const url = new URL(req.url, redirect.origin);
    const paths = ["/api/spotify/status", "/api/spotify/search", "/api/spotify/create-playlist", "/api/spotify/disconnect", "/auth/spotify/start", "/auth/spotify/callback"];
    if (!paths.includes(url.pathname)) return false;
    const [id, session] = sessionFrom(req);
    if (url.pathname === "/api/spotify/status" && req.method === "GET") {
      let connected = Boolean(session?.token);
      if (connected && session.token.expiresAt <= now() && session.token.refreshToken) { try { saveToken(session, await tokenRequest({ grant_type: "refresh_token", refresh_token: session.token.refreshToken })); } catch { delete session.token; connected = false; } }
      json(res, 200, { configured, connected, message: configured ? "Connect Spotify to search tracks and create a playlist." : "Add SPOTIFY_CLIENT_ID to .env to enable Spotify." }); return true;
    }
    if (url.pathname === "/auth/spotify/start" && req.method === "GET") {
      if (!configured) { json(res, 503, { error: "Spotify app registration is not configured." }); return true; }
      const sid = random(), state = random(), verifier = random();
      sessions.set(sid, { expiresAt: now() + 8 * 60 * 60 * 1000, pending: { state, verifier, expiresAt: now() + 10 * 60 * 1000 } });
      const auth = new URL(authorizeUrl); auth.search = new URLSearchParams({ client_id: env.SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: redirect.href, state, scope: "user-read-private playlist-modify-public playlist-modify-private", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      res.writeHead(302, { Location: auth.href, "Set-Cookie": cookie(sid), "Cache-Control": "no-store" }); res.end(); return true;
    }
    if (url.pathname === "/auth/spotify/callback" && req.method === "GET") {
      const pending = session?.pending;
      if (!pending || pending.expiresAt <= now() || !safeEqual(pending.state, url.searchParams.get("state")) || url.searchParams.has("error") || !url.searchParams.get("code")) { finish(res, false); return true; }
      delete session.pending;
      try { saveToken(session, await tokenRequest({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: redirect.href, code_verifier: pending.verifier })); finish(res, true); } catch { finish(res, false); }
      return true;
    }
    if (url.pathname === "/api/spotify/disconnect" && req.method === "POST") { if (req.headers.origin !== redirect.origin) { json(res, 403, { error: "Invalid request origin." }); return true; } if (id) sessions.delete(id); res.setHeader?.("Set-Cookie", cookie("", 0)); json(res, 200, { connected: false }); return true; }
    if (url.pathname === "/api/spotify/search" && req.method === "POST") {
      try {
        const { tracks } = JSON.parse(await new Response(req).text());
        if (!Array.isArray(tracks) || tracks.length > 100) { json(res, 400, { error: "tracks must be an array of at most 100 songs." }); return true; }
        const matches = [];
        for (const track of tracks) {
          const artist = String(track.artist || "").trim(), title = String(track.title || "").trim();
          if (!artist || !title) { matches.push({ rowId: track.id, candidates: [] }); continue; }
          // Pass 1 is precise. Pass 2 drops field qualifiers for OCR typos such as "Wou"/"Gou".
          // Pass 3 searches title only, which helps when both columns are slightly misread.
          const queries = [`track:${title} artist:${artist}`, `${title} ${artist}`, title].filter(Boolean);
          const seen = new Set();
          const candidates = [];
          for (const query of queries) {
            const data = await spotifyFetch(session, `/search?q=${encodeURIComponent(query)}&type=track&limit=10`);
            for (const item of data.tracks?.items || []) {
              if (seen.has(item.id)) continue;
              seen.add(item.id);
              const candidateArtist = item.artists.map((a) => a.name).join(", ");
              const titleScore = similarity(title, item.name);
              const artistScore = similarity(artist, candidateArtist);
              candidates.push({ id: item.id, uri: item.uri, artist: candidateArtist, title: item.name, album: item.album?.name || "", url: item.external_urls?.spotify || `https://open.spotify.com/track/${item.id}`, score: Math.round((titleScore * 0.6 + artistScore * 0.4) * 100), pass: queries.indexOf(query) + 1 });
            }
            if (candidates.length) break;
          }
          candidates.sort((a, b) => b.score - a.score);
          matches.push({ rowId: track.id, candidates: candidates.slice(0, 5) });
        }
        json(res, 200, { matches });
      } catch (error) { json(res, error.status || 500, { error: error.message }); }
      return true;
    }
    if (url.pathname === "/api/spotify/dj-search" && req.method === "POST") {
      try {
        const { artists } = JSON.parse(await new Response(req).text());
        if (!Array.isArray(artists) || artists.length > 20) { json(res, 400, { error: "artists must be an array of at most 20 names." }); return true; }
        const results = [];
        for (const name of artists.map((value) => String(value || "").trim()).filter(Boolean)) {
          const artistData = await spotifyFetch(session, `/search?q=${encodeURIComponent(`artist:${name}`)}&type=artist&limit=5`);
          const artist = (artistData.artists?.items || []).sort((a, b) => similarity(name, b.name) - similarity(name, a.name))[0];
          if (!artist) { results.push({ name, artist: null, tracks: [] }); continue; }
          const trackData = await spotifyFetch(session, `/search?q=${encodeURIComponent(`artist:${artist.name}`)}&type=track&limit=50`);
          const tracks = (trackData.tracks?.items || []).filter((track) => track.uri).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 7)
            .map((track) => ({ id: track.id, uri: track.uri, artist: track.artists.map((entry) => entry.name).join(", "), title: track.name, album: track.album?.name || "", url: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`, score: track.popularity || 0 }));
          results.push({ name, artist: { id: artist.id, name: artist.name, url: artist.external_urls?.spotify || `https://open.spotify.com/artist/${artist.id}` }, tracks });
        }
        json(res, 200, { results });
      } catch (error) { json(res, error.status || 500, { error: error.message }); }
      return true;
    }
    if (url.pathname === "/api/spotify/create-playlist" && req.method === "POST") {
      try {
        const body = JSON.parse(await new Response(req).text());
        const name = String(body.name || "CrateRadar: Tracklist").trim().slice(0, 100) || "CrateRadar: Tracklist";
        const uris = Array.isArray(body.uris) ? body.uris.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)).slice(0, 100) : [];
        const removeUris = Array.isArray(body.removeUris) ? body.removeUris.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)).slice(0, 100) : [];
        if (!uris.length && !body.tentative && !body.playlistId) { json(res, 400, { error: "At least one Spotify track is required." }); return true; }
        const me = await spotifyFetch(session, "/me");
        const playlist = body.playlistId
          ? { id: body.playlistId, external_urls: {} }
          : await spotifyFetch(session, "/me/playlists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, public: Boolean(body.public), description: "Created by PlayThisPic · tentative while tracks are matched" }) });
        if (body.playlistId && body.name) await spotifyFetch(session, `/playlists/${encodeURIComponent(body.playlistId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, public: Boolean(body.public), description: "Created by PlayThisPic" }) });
        if (removeUris.length) await spotifyFetch(session, `/playlists/${encodeURIComponent(playlist.id)}/items`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: removeUris.map((uri) => ({ uri })) }) });
        if (uris.length) await spotifyFetch(session, `/playlists/${encodeURIComponent(playlist.id)}/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uris }) });
        json(res, 201, { id: playlist.id, url: playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`, owner: me.display_name || me.id, count: uris.length });
      } catch (error) { json(res, error.status || 500, { error: error.message }); }
      return true;
    }
    json(res, 405, { error: "Method not allowed." }); return true;
  };
}
