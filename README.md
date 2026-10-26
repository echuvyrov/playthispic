# CrateRadar

Spotify-first app for turning a tracklist image into a reviewed playlist.

## What works now

- Upload, drop, or paste an image to preview it and automatically extract its text.
- Extract track text from images through a local OpenAI Responses API endpoint.
- Paste or edit raw OCR text.
- Extract separate artist, title, and chart-position fields, validate them, and re-read once when details are missing or uncertain.
- Search extracted tracks against Spotify and review candidate matches in separate Matched and Needs a match sections.
- Create a tentative Spotify playlist immediately after matching starts and update it as songs resolve; changing a candidate removes the previous provisional track.
- Build a tentative Spotify playlist as matches arrive, with matched and unmatched sections in the review console.
- Run the demo against nine local sample catalog entries, explicitly labeled as demo results.
- Review uncertain tracks, pick alternates, accept, or skip rows.
- Connect through Spotify OAuth and create a playlist from reviewed matches.
- Keep direct Beatport search links as a fallback.

## Platform notes

Beatport remains a fallback search link. Spotify is the primary provider for catalog matching and playlist creation.

Image OCR requires `OPENAI_API_KEY` in the server environment. The app sends image data URLs to the local `/api/extract-image` route, which calls the OpenAI Responses API with an image input.

## Creator support

The Support Creator flow uses Stripe Checkout Sessions. Add these server environment variables before testing it:

```env
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_SITE_URL=http://localhost:5174
```

`STRIPE_SECRET_KEY` is server-only and must never be added to client code or committed in `.env.local`. In production, use a live key and the public production URL, for example `NEXT_PUBLIC_SITE_URL=https://your-production-domain.com`.

Start the app with `npm run dev`, click Support Creator, choose an amount, and use Stripe test Checkout. Successful and cancelled sessions return to `/?support=success` and `/?support=cancelled` respectively.

Spotify search and playlist creation require a Spotify Developer app and a user with Spotify Premium. The Spotify Web API supports catalog search, playlist creation, and adding track URIs with OAuth scopes; see the [official Spotify API documentation](https://developer.spotify.com/documentation/web-api).

## Run

Requires Node.js 22 or newer.

```bash
npm run dev
```

Open `http://127.0.0.1:5174`.

To enable OCR, create a `.env` file in the project root:

```dotenv
OPENAI_API_KEY=your_api_key_here
# Optional settings:
OPENAI_OCR_MODEL=gpt-5
PORT=5174
```

Run `npm run dev` after saving the file. The server loads `.env` automatically;
existing shell environment variables take precedence. Restart the server after
changing `.env`. The file is optional, ignored by Git, and blocked from browser access.

## Vercel deployment

This project includes a Vercel serverless adapter for the API and OAuth routes.
Import the GitHub repository into Vercel with no build command and no output directory.
Set `OPENAI_API_KEY` and any Spotify/Beatport settings in the Vercel project
environment variables. For OAuth, update the provider redirect URIs to the deployed
HTTPS URL, for example `https://your-project.vercel.app/auth/spotify/callback`.

## Test

```bash
npm test
```

## Extraction harness

The contract, prompt, validation, and bounded retry policy live in `src/extraction.mjs`.
The server requests structured JSON using the Responses API, then validates nonempty
artist/title fields, uncertainty, and positive, nonduplicated chart positions. Missing
ranks are allowed and remain null. The original transcription is retained in the API
response; review uses the structured fields directly, without splitting OCR lines again.

Missing or uncertain fields (or zero songs) trigger one second read of the same image
with validation feedback. A worse or failed second read preserves the first for review.
After two reads, unresolved details remain flagged; missing names are never filled
with guesses. Completeness checks do not verify song identity or Beatport availability.
Both reads share a 120-second deadline. Replacing an image cancels the previous request.

The browser requests newline-delimited JSON progress events from `/api/extract-image`
so the radar reflects actual reading, validation, and repair stages. Other API clients
can still request a normal JSON response. Tests cover complete extraction, repair,
unresolved fields, dropped-row protection, retry failure, empty results, and ranks.

## Spotify account connection

Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Add this exact redirect URI:

`http://127.0.0.1:5174/auth/spotify/callback`

Then set `SPOTIFY_CLIENT_ID` and `SPOTIFY_REDIRECT_URI` in `.env` and restart the server. Spotify's PKCE flow keeps the client secret out of this app. The Connect Spotify button opens Spotify in a separate window. After approval, extracted songs are searched with `track:` and `artist:` filters; you choose candidates before creating a playlist. The app stores the access token in memory on the server and loses sessions on restart.

Each song is searched up to three ways: precise `track:` and `artist:` filters, a broad combined query, and a title-only query when needed. Results are deduplicated and fuzzy-ranked so small OCR errors can still surface a likely match. Search is intentionally conservative: it presents candidates for review rather than silently accepting a fuzzy result. Once connected, a tentative Spotify playlist is created empty and updated as candidates are found; selecting a different candidate replaces that song's provisional track instead of leaving a duplicate behind.

Routes: `GET /auth/spotify/start`, `GET /auth/spotify/callback`, `GET /api/spotify/status`, `POST /api/spotify/search`, `POST /api/spotify/create-playlist`, `POST /api/spotify/disconnect`.

Beatport remains a fallback search link only. Its old OAuth routes and configuration are retained separately for now.

## Beatport account connection (legacy)

The login window uses Beatport's authorization-code flow. Register your own OAuth
application through [Beatport developer access](https://api.beatport.com/v4/docs/)
first. A regular Beatport username/password is not an application client ID.

Add the following to `.env`, then restart the server:

```dotenv
BEATPORT_CLIENT_ID=your_registered_app_client_id
BEATPORT_CLIENT_SECRET=your_app_secret_if_issued
BEATPORT_REDIRECT_URI=http://127.0.0.1:5174/auth/beatport/callback
```

Register that exact redirect URI with Beatport. Open the app using the same hostname
(`127.0.0.1` here, not `localhost`). For a public deployment, use an HTTPS callback.
Only set `BEATPORT_SCOPES` if Beatport has supplied approved scopes for your app;
otherwise its defaults are used. The secret is optional for a registered public
client and must never be your Beatport account password.

The Connect button becomes available when a client ID is configured. The login
window leaves the current image and reviewed tracks in place. Authorization uses
state validation and an S256 PKCE challenge; the server exchanges the code and
stores tokens in memory behind an HttpOnly, SameSite cookie. Expired access tokens
are refreshed when account status is checked, if a refresh token was issued.
Sessions expire after eight hours and are lost on server restart. This local
prototype does not yet use a persistent session store for multiple server instances.
Disconnect clears this app's local session; it does not sign you out of Beatport
or revoke other sessions.

Routes: `GET /auth/beatport/start`, `GET /auth/beatport/callback`,
`GET /api/beatport/status`, `POST /api/beatport/disconnect`.
Account connection does not yet enable live catalog matching or playlist writes.
The flow has mock-provider tests; a live sign-in requires the registered app and
must be verified against its approved configuration.
