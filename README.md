# Stitch Network Test

A Stitch-branded site that tells a customer, in about a minute, whether their internet connection
can carry Stitch calls, how many at once, and what to fix. Support gets the same result by code,
or filed against a company when the customer came in on a support link.

Live at https://test.stitchuc.com. Staff view at `/staff`.

## What it does

1. **Network**: times a small request to each Stitch LiveKit region and names the provider.
2. **Call quality**: a real 20-second call through the nearest region that has keys set. The page
   sends a tone (the microphone is never used), listens for it from a second connection, and reads
   the browser's own call statistics: loss each way, jitter, round trip, and the path taken.
3. **Speed**: download and upload to this server, and the delay on the line while each runs.
4. **Firewall**: whether the call went over UDP or fell back, and whether Stitch's addresses answer.

The server works out the verdict, calls at once, what to fix and the firewall list
(`server/src/score.ts`, with its pass marks), and keeps the result for `NETTEST_KEEP_DAYS`.

## Layout

- `server/src`: Fastify 5 server. `index.ts` (routes), `score.ts` (verdicts and pass marks),
  `livekit.ts` (test call passes), `geo.ts` (provider lookup), `mail.ts`, `db.ts`, `config.ts`.
- `web/src`: React 19 site. `runner.ts` is the test; `Start`, `Running`, `ResultPage`, `Staff`.
- One Docker image serves both on port 4000.

## Run it

```bash
npm ci
npm run build
DATABASE_URL=postgres://... NETTEST_TRUST_PROXY=0 npm start     # http://localhost:4000
npm test                                                          # scoring tests
```

For development: `npm run dev:server` and `npm run dev:web` (Vite proxies `/api` to port 4000).

## EasyPanel

- App service built from this repo's `Dockerfile`, domain on container port **4000**, HTTPS.
- A Postgres service in the same project; put its address in `DATABASE_URL`.
- A volume at `/data` keeps the downloaded IP databases between deploys.
- Settings: see `.env.example`.
- DNS for the site must be **DNS only** in Cloudflare (grey cloud). Proxied, the speed test would
  measure Cloudflare's edge, not the customer's line.
- No compression or buffering on this service's routes.

## Things to know

- A test call makes a room named `nettest-<id>` on LiveKit for about 25 seconds. Its passes last
  two minutes and allow sound into that one room only.
- A browser can't check SIP ALG or the SIP ports (5060, 5061). Results say so.
- The speed test can't read higher than `NETTEST_MAX_MBPS`; above it, results say "at least".
- Results are open to anyone holding the link or code, without the IP address. The IP, network
  number, place and per-second figures are in the staff view only.
