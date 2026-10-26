import { validateTracks } from "./extraction.mjs";

export const demoCatalog = [
  {
    id: "bp-1001",
    artist: "Peggy Gou",
    title: "It Goes Like Nanana",
    mix: "Original Mix",
    label: "XL Recordings",
    duration: "6:07",
    url: "https://www.beatport.com/search?q=Peggy%20Gou%20It%20Goes%20Like%20Nanana"
  },
  {
    id: "bp-1002",
    artist: "Bicep",
    title: "Glue",
    mix: "Original Mix",
    label: "Ninja Tune",
    duration: "4:29",
    url: "https://www.beatport.com/search?q=Bicep%20Glue"
  },
  {
    id: "bp-1003",
    artist: "ANOTR, Abel Balder",
    title: "Relax My Eyes",
    mix: "Original Mix",
    label: "No Art",
    duration: "6:36",
    url: "https://www.beatport.com/search?q=ANOTR%20Abel%20Balder%20Relax%20My%20Eyes"
  },
  {
    id: "bp-1004",
    artist: "Honey Dijon, Hadiya George",
    title: "Not About You",
    mix: "Extended Mix",
    label: "Classic Music Company",
    duration: "7:03",
    url: "https://www.beatport.com/search?q=Honey%20Dijon%20Not%20About%20You"
  },
  {
    id: "bp-1005",
    artist: "Patrick Topping",
    title: "Be Sharp Say Nowt",
    mix: "Original Mix",
    label: "Hot Creations",
    duration: "6:58",
    url: "https://www.beatport.com/search?q=Patrick%20Topping%20Be%20Sharp%20Say%20Nowt"
  },
  {
    id: "bp-1006",
    artist: "Mochakk",
    title: "Jealous",
    mix: "Extended Mix",
    label: "CircoLoco Records",
    duration: "5:45",
    url: "https://www.beatport.com/search?q=Mochakk%20Jealous"
  },
  {
    id: "bp-1007",
    artist: "Mall Grab",
    title: "Love Reigns",
    mix: "Original Mix",
    label: "Looking For Trouble",
    duration: "5:52",
    url: "https://www.beatport.com/search?q=Mall%20Grab%20Love%20Reigns"
  },
  {
    id: "bp-1008",
    artist: "The Blessed Madonna, Jacob Lusk",
    title: "Mercy",
    mix: "Extended Mix",
    label: "Warner Records",
    duration: "6:01",
    url: "https://www.beatport.com/search?q=The%20Blessed%20Madonna%20Mercy%20Jacob%20Lusk"
  },
  {
    id: "bp-alt-1008",
    artist: "The Blessed Madonna",
    title: "Mercy",
    mix: "Radio Edit",
    label: "Warner Records",
    duration: "3:29",
    url: "https://www.beatport.com/search?q=The%20Blessed%20Madonna%20Mercy"
  }
];

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s&,+/().'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseTrackRows(rawText) {
  return String(rawText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const rank = line.match(/^\s*(\d+)[).:]?\s+/);
      const sourceText = line.slice(rank?.[0].length || 0).replace(/^[-*]\s+/, "").trim();
      const separators = [" - ", " – ", " — ", " by "];
      const separator = separators.find((item) => sourceText.toLowerCase().includes(item.toLowerCase()));
      let artist = "";
      let title = sourceText;

      if (separator) {
        const parts = sourceText.split(new RegExp(separator, "i"));
        artist = parts.shift().trim();
        title = parts.join(separator).trim();
        if (separator === " by ") [artist, title] = [title, artist];
      }

      title = title.replace(/\s+feat\.?\s+/i, " feat. ");
      const remixMatch = title.match(/\(([^)]*(mix|remix|edit|dub|version)[^)]*)\)/i);
      const remix = remixMatch ? remixMatch[1].trim() : "";
      const cleanTitle = title.replace(/\(([^)]*)\)/g, "").replace(/\s+/g, " ").trim();

      return {
        id: `row-${index + 1}`,
        index: index + 1,
        position: rank ? Number(rank[1]) : null,
        uncertain: false,
        artist,
        title: cleanTitle,
        remix,
        sourceText,
        confidence: artist && cleanTitle ? 0.72 : 0.42
      };
    });
}

export function structuredTrackRows(tracks) {
  return tracks.map((track, index) => ({
    ...track,
    id: `row-${index + 1}`,
    index: index + 1,
    remix: "",
    sourceText: track.sourceText || `${track.artist} - ${track.title}`,
    confidence: 0
  }));
}

export function tokenScore(query, candidate) {
  const left = new Set(normalizeText(query).split(" ").filter(Boolean));
  const right = new Set(normalizeText(candidate).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;

  let matches = 0;
  for (const token of left) {
    if (right.has(token)) matches += 1;
  }
  return matches / Math.max(left.size, right.size);
}

export function scoreCandidate(row, candidate) {
  const artist = tokenScore(row.artist, candidate.artist);
  const title = tokenScore(row.title, candidate.title);
  const remix = row.remix ? tokenScore(row.remix, candidate.mix) : 0.7;
  const source = tokenScore(row.sourceText, `${candidate.artist} ${candidate.title} ${candidate.mix}`);
  return Math.round((artist * 0.34 + title * 0.42 + remix * 0.12 + source * 0.12) * 100);
}

export function matchRows(rows, catalog = []) {
  const validation = validateTracks(rows);
  return rows.map((row) => {
    const candidates = catalog
      .map((candidate) => ({
        ...candidate,
        score: scoreCandidate(row, candidate)
      }))
      .filter((candidate) => candidate.score >= 24)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const best = candidates[0] || null;
    const issues = validation.find((entry) => entry.row === rows.indexOf(row) + 1)?.issues || [];
    const status = best && best.score >= 82 && !issues.length ? "accepted" : "review";

    return {
      ...row,
      status,
      issues,
      selectedId: best?.id || "",
      candidates,
      confidence: best ? best.score / 100 : row.confidence
    };
  });
}

export function createExport(rows) {
  return rows
    .filter((row) => row.status === "accepted")
    .map((row, index) => {
      const match = row.candidates.find((candidate) => candidate.id === row.selectedId) || row.candidates[0];
      return `${index + 1}. ${match ? `${match.artist} - ${match.title}${match.mix ? ` (${match.mix})` : ""}` : `${row.artist} - ${row.title}`}`;
    })
    .join("\n");
}
