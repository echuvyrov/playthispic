import { createExport, demoCatalog, matchRows, parseTrackRows, scoreCandidate, structuredTrackRows } from "./core.mjs";

const demoTrackText = `1. Peggy Gou - It Goes Like Nanana
2. Bicep - Glue
3. ANOTR, Abel Balder - Relax My Eyes
4. Honey Dijon feat. Hadiya George - Not About You
5. Patrick Topping - Be Sharp Say Nowt
6. Mochakk - Jealous
7. Mall Grab - Love Reigns
8. The Blessed Madonna - Mercy feat. Jacob Lusk`;

const state = {
  rows: [],
  demo: false,
  connected: false,
  spotifyConfigured: false,
  tentative: { id: "", url: "", uris: new Set(), byRow: new Map() },
  visibility: "Private",
  imageName: "",
  imageDataUrl: "",
  dragDepth: 0
};

const $ = (selector) => document.querySelector(selector);
let imageLoadId = 0;
let extractionId = 0;
let extractionController;

function suggestedPlaylistName(source = state.imageName) {
  const now = new Date();
  const monthYear = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(now);
  let label = String(source || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!label || /^(img|image|screenshot|photo|pasted image|untitled)(\s*\(?\d*\)?)?$/i.test(label)) label = "Tracklist";
  label = label.replace(/^crateradar\s*[:\-]?\s*/i, "").trim();
  const suffix = ` · ${monthYear}`;
  const available = 50 - "CrateRadar: ".length - suffix.length;
  label = label.slice(0, Math.max(1, available)).trim().replace(/[\s.,:;\-]+$/, "");
  return `CrateRadar: ${label}${suffix}`.slice(0, 50);
}

const elements = {
  radar: $("#radar"),
  catalogNotice: $("#catalogNotice"),
  validationSummary: $("#validationSummary"),
  dropzone: $("#dropzone"),
  uploadCore: $("#uploadCore"),
  imageInput: $("#imageInput"),
  imagePreview: $("#imagePreview"),
  previewPlaceholder: $("#previewPlaceholder"),
  manualText: $("#manualText"),
  extractMode: $("#extractMode"),
  extractBtn: $("#extractBtn"),
  demoBtn: $("#demoBtn"),
  trackTable: $("#trackTable"),
  acceptedCount: $("#acceptedCount"),
  reviewCount: $("#reviewCount"),
  skippedCount: $("#skippedCount"),
  loginBtn: $("#loginBtn"),
  loginDescription: $("#loginDescription"),
  createBtn: $("#createBtn"),
  acceptAllBtn: $("#acceptAllBtn"),
  visibilityBtn: $("#visibilityBtn"),
  playlistName: $("#playlistName"),
  fallbackNote: $("#fallbackNote"),
  resultCard: $("#resultCard"),
  resultTitle: $("#resultTitle"),
  resultCopy: $("#resultCopy"),
  playlistLink: $("#playlistLink"),
  copyExportBtn: $("#copyExportBtn"),
  tentativeCopy: $("#tentativeCopy"),
  tentativeList: $("#tentativeList"),
  tentativeLink: $("#tentativeLink"),
  signalLabel: $("#signalLabel"),
  signalDetail: $("#signalDetail"),
  globalDrop: $("#globalDrop"),
  supportCreator: $("#supportCreator"),
  supportTrigger: $("#supportTrigger"),
  supportModal: $("#supportModal"),
  supportDialog: $(".support-dialog"),
  supportClose: $("#supportClose"),
  supportSubmit: $("#supportSubmit"),
  supportError: $("#supportError"),
  amountOptions: [...document.querySelectorAll(".amount-option")]
};

function setSignal(label, detail, stage = "idle") {
  elements.radar.dataset.stage = stage;
  elements.radar.classList.toggle("processing", ["loading", "reading", "validating", "repairing", "searching"].includes(stage));
  elements.signalLabel.textContent = label;
  elements.signalDetail.textContent = detail;
}

function loadImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const loadId = ++imageLoadId;
  ++extractionId;
  extractionController?.abort();
  setSignal("Loading image", "Preparing your tracklist.", "loading");
  state.imageName = file.name || "pasted-image";
  elements.playlistName.value = suggestedPlaylistName(state.imageName);
  const reader = new FileReader();
  reader.onload = () => {
    if (loadId !== imageLoadId) return;
    state.imageDataUrl = String(reader.result || "");
    elements.imagePreview.src = reader.result;
    elements.imagePreview.classList.add("loaded");
    elements.previewPlaceholder.hidden = true;
    document.body.classList.add("image-armed");
    elements.manualText.value = "";
    state.rows = [];
    updateStats();
    void runExtraction("image");
  };
  reader.onerror = () => {
    if (loadId !== imageLoadId) return;
    showOcrFailure("Could not open this image. Please try another file.");
    elements.extractBtn.disabled = false;
  };
  reader.readAsDataURL(file);
}

function getDraggedImage(event) {
  return [...(event.dataTransfer?.files || [])].find((file) => file.type.startsWith("image/"));
}

function setDropActive(isActive) {
  document.body.classList.toggle("drop-active", isActive);
  elements.globalDrop.setAttribute("aria-hidden", String(!isActive));
}

function showOcrFailure(message) {
  state.rows = [];
  elements.trackTable.innerHTML = `
    <div class="ocr-pending">
      <span class="pulse-dot"></span>
      <strong>Image extraction paused</strong>
      <p class="failure-message"></p>
      <small>Paste track text below or use the demo tracklist.</small>
    </div>
  `;
  elements.trackTable.querySelector(".failure-message").textContent = message;
  setSignal("Read paused", message, "error");
  updateStats();
}

async function extractTextFromImage(currentExtraction, signal) {
  const response = await fetch("/api/extract-image", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ imageDataUrl: state.imageDataUrl, mode: elements.extractMode.value })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Image extraction failed.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let result;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "progress" && currentExtraction === extractionId) {
      setSignal(event.label, event.detail, event.stage);
    }
    if (event.type === "result") result = event;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      lines.forEach(consume);
    }
    consume(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error("The image read ended before a result arrived. Please try again.");
  return result;
}

function resetTentative() {
  state.tentative = { id: "", url: "", uris: new Set(), byRow: new Map() };
  renderTentative();
}

function renderTentative() {
  const matched = state.rows.filter((row) => row.candidates?.length && row.selectedId)
    .map((row) => ({ row, candidate: row.candidates.find((candidate) => candidate.id === row.selectedId) || row.candidates[0] }));
  elements.tentativeList.innerHTML = matched.length
    ? matched.map(({ row, candidate }, index) => `<div class="tentative-item"><span>${row.position ?? index + 1}</span><div><strong>${candidate.artist} — ${candidate.title}</strong><small>${state.connected && !state.demo ? "Spotify match" : "Ready for review"}</small></div></div>`).join("")
    : `<p class="tentative-empty">No matched songs yet.</p>`;
  elements.tentativeCopy.textContent = state.tentative.id
    ? `${matched.length} matched song${matched.length === 1 ? "" : "s"} added as the scan progresses.`
    : state.connected && !state.demo ? "Creating a playlist as Spotify matches arrive…" : "Connect Spotify, then tracks will appear here as they are matched.";
  elements.tentativeLink.hidden = !state.tentative.url;
  elements.tentativeLink.href = state.tentative.url || "#";
}

async function ensureTentativePlaylist(signal) {
  if (!state.connected || state.demo || state.tentative.id) return;
  const response = await fetch("/api/spotify/create-playlist", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: elements.playlistName.value || suggestedPlaylistName("Tracklist"), public: state.visibility === "Public", tentative: true, uris: [] })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not create the tentative Spotify playlist.");
  state.tentative.id = payload.id;
  state.tentative.url = payload.url;
  renderTentative();
}

async function addTentativeTrack(row, candidate, signal) {
  if (!state.tentative.id || !candidate?.uri) return;
  const previous = state.tentative.byRow.get(row.id);
  if (previous === candidate.uri) return;
  const response = await fetch("/api/spotify/create-playlist", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playlistId: state.tentative.id, uris: [candidate.uri], removeUris: previous ? [previous] : [] })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not update the tentative Spotify playlist.");
  state.tentative.uris.add(candidate.uri);
  if (previous) state.tentative.uris.delete(previous);
  state.tentative.byRow.set(row.id, candidate.uri);
  renderTentative();
}

async function searchSpotifyMatches(rows, signal) {
  await ensureTentativePlaylist(signal);
  for (const [index, row] of rows.entries()) {
    setSignal("Searching Spotify", `Checking song ${index + 1} of ${rows.length}.`, "searching");
    const response = await fetch("/api/spotify/search", {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracks: [{ id: row.id, artist: row.artist, title: row.title }] })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Spotify search failed.");
    row.candidates = (payload.matches?.[0]?.candidates || []).map((candidate) => ({ ...candidate, score: Math.max(candidate.score || 0, scoreCandidate(row, candidate)) }));
    const best = row.candidates[0];
    row.selectedId = best?.id || "";
    row.confidence = best ? best.score / 100 : row.confidence;
    row.status = "review";
    renderRows();
    renderTentative();
    await addTentativeTrack(row, best, signal);
  }
}

async function searchDjs(names, signal) {
  const response = await fetch("/api/spotify/dj-search", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artists: names }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Spotify DJ search failed.");
  return payload.results || [];
}

async function runExtraction(source = "manual") {
  const currentExtraction = ++extractionId;
  extractionController?.abort();
  extractionController = new AbortController();
  state.demo = source === "demo";
  // Resolve the initial status check before deciding whether to skip live
  // matching. A fast upload can otherwise race page setup and mark every row
  // unmatched while Spotify is already connected.
  if (!state.demo && !state.spotifyConfigured) await refreshSpotifyStatus();
  elements.validationSummary.hidden = true;
  elements.resultCard.hidden = true;
  elements.catalogNotice.textContent = state.demo
    ? "Demo mode: matching against nine sample Spotify-shaped entries only. These are not live results."
    : state.connected
      ? "Spotify is connected. Searching its catalog for your extracted songs."
      : "Connect Spotify to search its catalog. Beatport links remain available as a fallback.";
  const rawText = state.demo ? demoTrackText : source === "image" ? "" : elements.manualText.value.trim();
  if (state.demo) elements.manualText.value = rawText;
  elements.extractBtn.disabled = true;
  state.rows = [];
  resetTentative();
  updateStats();
  try {
    let rows;
    let validation;
    if (!rawText && state.imageDataUrl) {
      elements.trackTable.innerHTML = `<div class="scanning"><span></span><p>Reading songs from your image…</p></div>`;
      setSignal("Reading image", "Finding artists, titles and chart positions.", "reading");
      const result = await extractTextFromImage(currentExtraction, extractionController.signal);
      if (currentExtraction !== extractionId) return;
      if (elements.extractMode.value === "djs" || (elements.extractMode.value === "auto" && !result.tracks.length && result.djCandidates?.length)) {
        setSignal("Finding DJ tracks", "Resolving artists and selecting representative songs.", "searching");
        const djResults = state.connected ? await searchDjs(result.djCandidates, extractionController.signal) : [];
        rows = djResults.flatMap((dj) => dj.tracks.map((track) => ({ id: `dj-${track.id}`, index: 0, position: null, artist: track.artist, title: track.title, remix: "", sourceText: `${track.artist} - ${track.title}`, confidence: track.score / 100, status: "review", issues: [], selectedId: track.id, candidates: [track] })));
        elements.manualText.value = result.djCandidates.join("\n");
      } else rows = structuredTrackRows(result.tracks);
      validation = result.validation;
      // Structured fields go directly to review; do not split OCR lines again.
      elements.manualText.value = result.tracks.map((track) =>
        `${track.position == null ? "" : `${track.position}. `}${track.artist} - ${track.title}`
      ).join("\n");
    } else if (rawText) {
      setSignal("Checking tracks", "Separating artists and titles.", "validating");
      rows = parseTrackRows(rawText);
    } else {
      showOcrFailure("Drop an image or enter one song per line: Artist - Title.");
      return;
    }
    if (!rows.length) {
      showOcrFailure("No songs found. Try a clearer image or crop to the tracklist.");
      return;
    }
    state.rows = matchRows(rows, state.demo ? demoCatalog : []);
    if (!state.demo && state.connected) {
      setSignal("Searching Spotify", "Comparing artists and titles in the Spotify catalog.", "searching");
      await searchSpotifyMatches(state.rows, extractionController.signal);
      if (currentExtraction !== extractionId) return;
    }
    renderRows();
    const incomplete = state.rows.filter((row) => row.issues.length).length;
    elements.validationSummary.hidden = false;
    elements.validationSummary.textContent = [
      `${rows.length} songs · ${validation?.passes || 1} ${validation?.passes === 2 ? "reads" : "read"}.`,
      incomplete ? `${incomplete} need a closer look. Missing fields stay blank.` : "Every song has an artist and title. Review them against the image.",
      validation?.warning || ""
    ].join(" ");
    setSignal(incomplete ? "Check details" : "Tracks ready", `${rows.length} songs found · ${incomplete ? `${incomplete} need attention` : "review below"}`, incomplete ? "review" : "ready");
    const review = $("#trackReview");
    review.focus({ preventScroll: true });
    review.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      block: "start"
    });
  } catch (error) {
    if (currentExtraction !== extractionId || error.name === "AbortError") return;
    showOcrFailure(error.message);
  } finally {
    if (currentExtraction === extractionId) elements.extractBtn.disabled = false;
  }
}

function renderRows() {
  elements.trackTable.innerHTML = "";
  if (!state.rows.length) {
    elements.trackTable.innerHTML = `<div class="empty-state"><span class="pulse-dot"></span><p>Load an image or text to start resolving tracks.</p></div>`;
    updateStats();
    return;
  }

  const template = $("#trackRowTemplate");
  const groups = new Map();
  for (const [kind, label] of [["matched", "Matched in Spotify"], ["unmatched", "Needs a match"]]) {
    const section = document.createElement("section");
    section.className = "track-group";
    section.dataset.kind = kind;
    section.innerHTML = `<h3 class="track-group-title">${label}<span></span></h3><div class="track-group-list"></div>`;
    elements.trackTable.appendChild(section);
    groups.set(kind, section);
  }
  groups.get("matched").querySelector("h3 span").textContent = `${state.rows.filter((row) => row.candidates?.length).length} songs`;
  groups.get("unmatched").querySelector("h3 span").textContent = `${state.rows.filter((row) => !row.candidates?.length).length} songs`;
  state.rows.forEach((row) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const best = row.candidates.find((candidate) => candidate.id === row.selectedId) || row.candidates[0];
    node.dataset.status = row.status;
    node.querySelector(".row-index").textContent = row.position == null ? "—" : String(row.position).padStart(2, "0");
    node.querySelector(".row-index").title = row.position == null ? "No chart position shown" : `Chart position ${row.position}`;
    node.querySelector(".artist-edit").value = row.artist;
    node.querySelector(".title-edit").value = row.title;
    node.querySelector(".track-issues").textContent = row.issues.join(" · ");
    node.querySelector(".accept").disabled = !best || !row.artist.trim() || !row.title.trim();
    node.querySelector(".confidence").textContent = state.demo ? `${Math.round(row.confidence * 100)}% demo` : row.status === "accepted" ? "Reviewed" : row.issues.length ? "Check" : "Extracted";
    node.querySelector(".confidence").dataset.level = row.confidence >= 0.82 ? "high" : row.confidence >= 0.55 ? "mid" : "low";

    const list = node.querySelector(".candidate-list");
    if (!row.candidates.length) {
      const note = document.createElement("p");
      note.className = "match-note";
      note.textContent = state.demo ? "No match in the sample catalog." : "No Spotify match after three search passes. Search Beatport as a fallback.";
      list.appendChild(note);
    } else {
      row.candidates.forEach((candidate) => {
        const button = document.createElement("button");
        button.className = `candidate ${candidate.id === row.selectedId ? "selected" : ""}`;
        button.type = "button";
        button.innerHTML = `
          <strong>${candidate.artist} - ${candidate.title}</strong>
          <span>${state.demo ? `DEMO / ${candidate.mix} / ${candidate.label} / ${candidate.duration} / ${candidate.score}%` : `SPOTIFY / ${candidate.album || "Track"}`}</span>
        `;
        button.addEventListener("click", () => {
          row.selectedId = candidate.id;
          row.status = "accepted";
          row.confidence = candidate.score / 100;
          renderRows();
          void addTentativeTrack(row, candidate, extractionController?.signal);
        });
        list.appendChild(button);
      });
    }

    node.querySelector(".accept").addEventListener("click", () => {
      row.status = "accepted";
      if (!row.selectedId && best) row.selectedId = best.id;
      renderRows();
      void addTentativeTrack(row, best, extractionController?.signal);
    });

    node.querySelector(".skip").addEventListener("click", () => {
      row.status = "skipped";
      renderRows();
    });

    const search = document.createElement("a");
    search.className = "track-search";
    search.textContent = "Search Beatport fallback ↗";
    search.href = `https://www.beatport.com/search?q=${encodeURIComponent(`${row.artist} ${row.title}`)}`;
    search.target = "_blank";
    search.rel = "noopener noreferrer";
    list.appendChild(search);

    const editTrack = () => {
      const artist = node.querySelector(".artist-edit").value.trim();
      const title = node.querySelector(".title-edit").value.trim();
      const updatedRows = state.rows.map((entry) => entry.id === row.id
        ? { ...entry, artist, title, sourceText: `${artist} - ${title}`, uncertain: false }
        : entry);
      const updated = matchRows(updatedRows, state.demo ? demoCatalog : []).find((entry) => entry.id === row.id);
      Object.assign(row, updated);
      renderRows();
    };
    node.querySelector(".artist-edit").addEventListener("change", editTrack);
    node.querySelector(".title-edit").addEventListener("change", editTrack);

    groups.get(row.candidates?.length ? "matched" : "unmatched").querySelector(".track-group-list").appendChild(node);
  });

  for (const section of groups.values()) if (!section.querySelector(".track-group-list").children.length) section.remove();

  updateStats();
  renderTentative();
}

function updateStats() {
  const selectedRows = state.rows.filter((row) => row.status === "accepted" && row.candidates?.some((candidate) => candidate.id === row.selectedId && candidate.uri));
  const counts = {
    accepted: state.rows.filter((row) => row.candidates?.length).length,
    review: state.rows.filter((row) => !row.candidates?.length && row.status !== "skipped").length,
    skipped: state.rows.filter((row) => row.status === "skipped").length,
    selected: selectedRows.length
  };

  elements.acceptedCount.textContent = counts.accepted;
  elements.reviewCount.textContent = counts.review;
  elements.skippedCount.textContent = counts.skipped;
  elements.createBtn.disabled = !counts.selected;
  elements.acceptAllBtn.disabled = !state.rows.some((row) => row.candidates?.length && row.status !== "accepted");
}

async function acceptAllMatched() {
  const matched = state.rows.filter((row) => row.candidates?.length);
  if (!matched.length) return;
  elements.acceptAllBtn.disabled = true;
  const signal = extractionController?.signal;
  try {
    for (const row of matched) {
      const candidate = row.candidates.find((entry) => entry.id === row.selectedId) || row.candidates[0];
      row.selectedId = candidate.id;
      row.status = "accepted";
      row.confidence = candidate.score / 100;
      await addTentativeTrack(row, candidate, signal);
    }
    renderRows();
  } catch (error) {
    if (error.name !== "AbortError") elements.catalogNotice.textContent = error.message;
    renderRows();
  }
}

let loginWindow;
let loginPoll;
let spotifyStatusPromise;

async function refreshSpotifyStatus() {
  if (spotifyStatusPromise) return spotifyStatusPromise;
  spotifyStatusPromise = (async () => {
  try {
    const response = await fetch("/api/spotify/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Connection status unavailable.");
    const status = await response.json();
    state.connected = status.connected;
    state.spotifyConfigured = status.configured;
    elements.loginBtn.disabled = !status.configured;
    elements.loginBtn.textContent = !status.configured ? "Spotify setup required" : status.connected ? "Disconnect Spotify" : "Connect Spotify";
    $("#spotifySetupLink").hidden = status.configured;
    elements.loginBtn.classList.toggle("connected", status.connected);
    elements.loginDescription.textContent = status.connected
      ? "Your Spotify account is connected. Search and playlist creation are ready."
      : !status.configured
        ? "Add SPOTIFY_CLIENT_ID to .env and restart the server."
        : status.message;
  } catch {
    state.connected = false;
    state.spotifyConfigured = false;
    elements.loginBtn.disabled = true;
    elements.loginBtn.textContent = "Spotify unavailable";
    elements.loginDescription.textContent = "Could not check the Spotify connection. Refresh the page to retry.";
  } finally {
    spotifyStatusPromise = null;
  }
  })();
  return spotifyStatusPromise;
}

async function connectSpotify() {
  if (state.connected) {
    elements.loginBtn.disabled = true;
    try {
      const response = await fetch("/api/spotify/disconnect", { method: "POST" });
      if (!response.ok) throw new Error("Could not disconnect. Please try again.");
      await refreshSpotifyStatus();
    } catch (error) {
      elements.loginDescription.textContent = error.message;
      elements.loginBtn.disabled = false;
    }
    return;
  }
  if (loginWindow && !loginWindow.closed) { loginWindow.focus(); return; }
  loginWindow = window.open("/auth/spotify/start", "playthispic-spotify", "popup,width=560,height=760");
  if (!loginWindow) {
    elements.loginDescription.textContent = "Allow the login window in your browser, then try again.";
    return;
  }
  elements.loginDescription.textContent = "Finish signing in in the Spotify window. Your tracks will stay here.";
  const started = Date.now();
  loginPoll = window.setInterval(() => {
    if (loginWindow.closed || Date.now() - started > 10 * 60 * 1000) {
      window.clearInterval(loginPoll);
      void refreshSpotifyStatus();
    }
  }, 750);
}

window.addEventListener("message", async (event) => {
  if (event.origin !== window.location.origin || event.source !== loginWindow || event.data?.type !== "spotify-auth") return;
  window.clearInterval(loginPoll);
  await refreshSpotifyStatus();
  if (!event.data.success) elements.loginDescription.textContent = "Spotify sign-in did not complete. Please try again.";
  if (event.data.success && state.connected && state.rows.length && !state.demo) {
    const controller = new AbortController();
    extractionController?.abort();
    extractionController = controller;
    elements.catalogNotice.textContent = "Spotify is connected. Searching its catalog for your extracted songs.";
    try {
      await searchSpotifyMatches(state.rows, controller.signal);
      renderRows();
    } catch (error) {
      if (error.name !== "AbortError") elements.catalogNotice.textContent = error.message;
      renderRows();
    }
  }
});

async function createPlaylist() {
  const exportText = createExport(state.rows);
  const accepted = state.rows.filter((row) => row.status === "accepted").length;
  const query = encodeURIComponent(elements.playlistName.value || "PlayThisPic");
  const fallbackUrl = `https://www.beatport.com/search?q=${query}`;

  if (state.connected && !state.demo) {
    const uris = state.rows.filter((row) => row.status === "accepted")
      .map((row) => row.candidates.find((candidate) => candidate.id === row.selectedId)?.uri)
      .filter(Boolean);
    elements.createBtn.disabled = true;
    elements.resultCard.hidden = false;
    elements.resultTitle.textContent = "Creating Spotify playlist…";
    elements.resultCopy.textContent = `Adding ${uris.length} reviewed tracks to Spotify.`;
    try {
      const response = await fetch("/api/spotify/create-playlist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: elements.playlistName.value, public: state.visibility === "Public", playlistId: state.tentative.id || undefined, removeUris: state.tentative.id ? [...state.tentative.uris] : [], uris })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Spotify playlist creation failed.");
      elements.resultTitle.textContent = state.tentative.id ? "Spotify playlist updated" : "Spotify playlist created";
      elements.resultCopy.textContent = `${payload.count} tracks were added to Spotify.`;
      elements.playlistLink.href = state.tentative.url || payload.url;
      elements.playlistLink.textContent = "Open Spotify ↗";
      elements.copyExportBtn.dataset.export = exportText;
      return;
    } catch (error) {
      elements.resultTitle.textContent = "Spotify playlist failed";
      elements.resultCopy.textContent = error.message;
    } finally {
      updateStats();
    }
    return;
  }

  elements.resultCard.hidden = false;
  elements.resultTitle.textContent = "Track export ready";
  elements.resultCopy.textContent = `${accepted} reviewed tracks are ready to copy. Connect Spotify to create the playlist directly.`;
  elements.playlistLink.href = fallbackUrl;
  elements.copyExportBtn.dataset.export = exportText;
  window.open(fallbackUrl, "_blank", "noopener,noreferrer");
}

async function copyExport() {
  const text = elements.copyExportBtn.dataset.export || createExport(state.rows);
  if (!text) return;
  await navigator.clipboard.writeText(text);
  elements.copyExportBtn.textContent = "Copied";
  window.setTimeout(() => {
    elements.copyExportBtn.textContent = "Copy export";
  }, 1200);
}

let selectedSupportAmount = 3;
let supportReturnFocus;
let supportThankYou = false;

function renderSupportState() {
  const status = new URLSearchParams(window.location.search).get("support");
  if (!status || !["success", "cancelled"].includes(status)) return;
  const success = status === "success";
  elements.supportCreator.classList.add("support-complete", success ? "is-success" : "is-cancelled");
  elements.supportCreator.querySelector(".support-signal").hidden = true;
  elements.supportCreator.querySelector(".support-copy").innerHTML = `<p class="eyebrow">${success ? "Signal received" : "Checkout paused"}</p><h2>${success ? "Thank you." : "No worries."}</h2><p>${success ? "Your support keeps the lights on and the project moving forward." : "The project will still be here."}</p>`;
  elements.supportTrigger.hidden = true;
  if (success) {
    supportThankYou = true;
    elements.supportDialog.querySelector(".eyebrow").textContent = "Signal received";
    elements.supportDialog.querySelector("#supportDialogTitle").textContent = "Thank you.";
    elements.supportDialog.querySelector("#supportDialogCopy").textContent = "Your support keeps the lights on and the project moving forward.";
    elements.supportDialog.querySelector(".amount-grid").hidden = true;
    elements.supportError.hidden = true;
    elements.supportSubmit.textContent = "Back to building";
    elements.supportModal.hidden = false;
    document.body.classList.add("modal-open");
    elements.supportDialog.focus();
  }
}

function setSupportAmount(amount) {
  selectedSupportAmount = amount;
  elements.amountOptions.forEach((option) => {
    const selected = Number(option.dataset.amount) === amount;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-pressed", String(selected));
  });
}

function openSupportModal() {
  supportReturnFocus = document.activeElement;
  elements.supportError.hidden = true;
  elements.supportModal.hidden = false;
  document.body.classList.add("modal-open");
  setSupportAmount(selectedSupportAmount);
  elements.supportDialog.focus();
}

function closeSupportModal() {
  elements.supportModal.hidden = true;
  document.body.classList.remove("modal-open");
  supportReturnFocus?.focus?.();
}

async function startSupportCheckout() {
  if (supportThankYou) {
    closeSupportModal();
    return;
  }
  elements.supportSubmit.disabled = true;
  elements.supportSubmit.textContent = "Preparing secure checkout…";
  elements.supportError.hidden = true;
  try {
    const response = await fetch("/api/support", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ amount: selectedSupportAmount })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.url) throw new Error(payload.error || "Could not start checkout. Please try again.");
    window.location.assign(payload.url);
  } catch (error) {
    elements.supportError.textContent = error.message;
    elements.supportError.hidden = false;
    elements.supportSubmit.disabled = false;
    elements.supportSubmit.textContent = "Continue to secure checkout ↗";
  }
}

function handleSupportKeydown(event) {
  if (elements.supportModal.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeSupportModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [elements.supportClose, ...elements.amountOptions, elements.supportSubmit].filter((element) => !element.disabled && !element.hidden && element.offsetParent !== null);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function wireEvents() {

  elements.uploadCore.addEventListener("click", () => elements.imageInput.click());
  elements.dropzone.addEventListener("click", () => elements.imageInput.click());
  elements.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") elements.imageInput.click();
  });
  elements.imageInput.addEventListener("change", (event) => {
    loadImage(event.target.files[0]);
    event.target.value = "";
  });
  elements.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("dragging");
  });
  elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("dragging"));
  elements.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.dropzone.classList.remove("dragging");
    state.dragDepth = 0;
    setDropActive(false);
    loadImage(getDraggedImage(event));
  });
  window.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    state.dragDepth += 1;
    setDropActive(true);

  });
  window.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) setDropActive(false);
  });
  window.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    state.dragDepth = 0;
    setDropActive(false);
    const image = getDraggedImage(event);
    if (image) {
      loadImage(image);
    } else {
      setSignal("Image needed", "Drop a PNG, JPG, screenshot, poster, or camera image.");
    }
  });
  window.addEventListener("paste", (event) => {
    const image = [...event.clipboardData.items]
      .find((item) => item.type.startsWith("image/"))
      ?.getAsFile();
    if (image) {
      loadImage(image);
      document.body.classList.add("paste-flash");
      window.setTimeout(() => document.body.classList.remove("paste-flash"), 520);
    }
  });
  elements.extractBtn.addEventListener("click", () => runExtraction("manual"));
  elements.demoBtn.addEventListener("click", () => runExtraction("demo"));
  elements.loginBtn.addEventListener("click", connectSpotify);
  elements.createBtn.addEventListener("click", createPlaylist);
  elements.acceptAllBtn.addEventListener("click", () => void acceptAllMatched());
  elements.copyExportBtn.addEventListener("click", copyExport);
  elements.supportTrigger.addEventListener("click", openSupportModal);
  elements.supportClose.addEventListener("click", closeSupportModal);
  elements.supportModal.querySelector("[data-support-close]").addEventListener("click", closeSupportModal);
  elements.amountOptions.forEach((option) => option.addEventListener("click", () => setSupportAmount(Number(option.dataset.amount))));
  elements.supportSubmit.addEventListener("click", () => void startSupportCheckout());
  document.addEventListener("keydown", handleSupportKeydown);
  elements.visibilityBtn.addEventListener("click", () => {
    state.visibility = state.visibility === "Private" ? "Public" : "Private";
    elements.visibilityBtn.textContent = state.visibility;
    elements.visibilityBtn.setAttribute("aria-pressed", String(state.visibility === "Public"));
  });
}

wireEvents();
renderSupportState();
renderRows();
void refreshSpotifyStatus();
