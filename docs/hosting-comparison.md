# Multiplayer Server Hosting Comparison

**Decision needed:** where to host the Node + WebSocket server that backs Phase 6 multiplayer.

**Priority: end-user experience.** Every comparison criterion below is a UX criterion in disguise.

**Recommendation:** **Cloudflare Durable Objects** (likely via PartyKit/PartyServer for ergonomics, raw if we want full control). Detail and alternatives below.

---

## What "great UX" means here

| User-facing thing they feel | Backend property that produces it |
|---|---|
| "Quickplay" loads a race instantly when I click | No cold start. Process is warm at first connection. |
| Other racers' cars move smoothly, in sync with my own | Low input-to-broadcast latency end-to-end |
| The game works equally well from NYC, SF, Berlin, Tokyo | Edge proximity, not single-region routing |
| Friday-night usage spike doesn't break the game | Per-room scale, no shared bottleneck |
| One bad connection or buggy client doesn't kick everyone out of every room | Per-room isolation; rooms are independent failure domains |
| Rooms persist if a player rejoins after a brief network blip | State persistence at the room layer |

These are the requirements. Cost / dev complexity / lock-in are secondary — they only matter if they prevent shipping the experience above.

---

## Comparison at a glance

| Option | Cold start? | Latency model | Per-room isolation | Scales to many rooms | Cost (this scale) |
|---|---|---|---|---|---|
| **Cloudflare Durable Objects (raw)** | No | Edge — ~50ms to 95% of users | Yes — each room is its own actor | Millions of rooms, automatic | Free tier likely covers; $5/mo cap |
| **PartyKit (on Cloudflare DO)** | No | Edge — same as DO | Yes — same as DO | Same as DO | Same as DO |
| **Fly.io shared-cpu-1x always-on** | No | Single region (multi-region adds cost + complexity) | No — one process, all rooms | Vertical only by default | ~$2/mo |
| **Render Starter** | No | Single region | No — one process, all rooms | Vertical only by default | $7/mo |
| **Railway Hobby** | No | Single region | No — one process, all rooms | Vertical only by default | $5/mo + usage |
| **DigitalOcean App Platform Basic** | No | Single region | No — one process, all rooms | Vertical only by default | $5/mo |
| **VPS (Hetzner/Linode)** | No | Single region | No — one process, all rooms | Manual horizontal scale | $4–6/mo |
| Render free / Koyeb free / Heroku Eco | **Yes (sleeps)** | — | — | — | $0 |
| Vercel / Netlify | N/A | — | — | Not designed for persistent WS | — |
| AWS Lambda + API Gateway WS | Yes | Multi-region available | Stateless, needs DynamoDB | Function-based | Free tier large |

Sleeping tiers and serverless-function platforms are eliminated by the "Quickplay loads instantly" requirement.

---

## The UX-driving insight

Most options here run **one Node process that holds every room in memory**. That works fine for one player on a laptop testing locally. For real users, three things break:

1. **Latency for distant users.** A single-region Node server in `us-east` means Tokyo players eat 150–250ms RTT on every keypress broadcast. The race feels laggy through no fault of the gameplay.
2. **One bad room blasts everyone.** A bug, a crash, a memory leak, a flood of input from a single misbehaving client — all of it lives in the same process. Every other room dies with it.
3. **Scale-out is your problem.** When the server hits its connection limit, you bolt on Redis pub/sub, sticky sessions, a load balancer. Players notice the seams.

**Cloudflare Durable Objects fix all three by inverting the model.** Each race room is its own actor, instantiated on demand at the edge nearest the first player who joins, with its own memory and its own WebSocket connections. Tokyo players hit Cloudflare's Tokyo edge. A bug in room A can't touch room B. Adding rooms 100 through 1,000 is automatic — there's no "the server" to overload.

This is exactly the multiplayer use case Cloudflare designed DOs around. The UX you can deliver is meaningfully different from what a single-process host can deliver.

---

## Top contenders, in detail

### 1. Cloudflare Durable Objects — recommended

**What the player feels:**
- Race starts instantly, anywhere in the world
- Smooth opponent motion regardless of geographic distance between players
- A buggy room never affects other rooms
- Game stays available during traffic spikes

**Mechanics:** One DO class = one race room. The `wrangler` route maps `/room/:id` → that room's DO. Players open a WebSocket directly to their room. The DO holds the problem queue, scores, finish times. WebSocket Hibernation API keeps idle connections cheap. When the race ends, the DO writes results to D1 (Cloudflare's SQLite) for the leaderboard and goes dormant.

**Trade-offs:**
- Not Socket.io. The dev cost is rewriting `runner.js`'s emitter wiring against raw WebSockets. Event shape stays the same; the transport changes. Likely 1–2 days extra vs Socket.io, paid once.
- Vendor lock-in is real. DOs are a Cloudflare primitive. If we ever want to leave Cloudflare, this is a rewrite.
- Costs: free tier (100K req/day, 13K GB-s/day) likely covers the whole project. $5/mo Workers Paid plan is the ceiling unless usage genuinely takes off.

### 2. PartyKit / PartyServer (on Cloudflare DO)

Same architecture, same UX, friendlier API. PartyServer is the actively-maintained piece inside the `cloudflare/partykit` repo.

**Why this might be the right call instead of raw DO:**
- Ports more directly from the existing `runner.js` event-emitter shape (closer to Socket.io's mental model)
- Saves 1–2 days of dev time
- Same edge latency, same per-room isolation, same scale story — because it *is* DO underneath

**Trade-off:** the framework's long-term roadmap is uncertain after Cloudflare's acquisition. Worst-case, we eject to raw DO later — which is doable because the underlying primitive is the same.

For a UX-first build, **PartyServer is probably the better pick**: same player experience, ships faster, lets us spend the saved time on actual gameplay polish.

### 3. Fly.io shared-cpu-1x always-on

**What the player feels:**
- Race starts instantly (always-on machine)
- Tokyo and Berlin users feel laggier than US users (single region by default)
- A crash in one room kills every room
- Scale-out is a project we'd have to build

**When this is the right call:** if we strongly want familiar tools (Socket.io, Node) and accept the latency / isolation trade-offs. Cheap (~$2/mo). No vendor lock-in.

**Why not for us:** the player experience is meaningfully worse for non-US users, and the per-room isolation is something we'd have to reinvent if the project grows.

### 4. Render Starter / Railway Hobby / DigitalOcean App Platform

All effectively the same shape as Fly.io: one Node process, single region, no per-room isolation. They differ on price ($5–7/mo), deploy DX, and brand. None of them solve the latency or isolation problems above.

### 5. VPS (Hetzner / Linode)

Cheapest option ($4–6/mo) with the worst ops UX for us. Every hour spent on Nginx config or systemd units is an hour not improving the game. Same single-region, no-isolation downsides as the platforms above.

---

## Eliminated

- **Sleeping free tiers (Render free, Koyeb free, Heroku Eco):** A 30-second cold start when a player clicks Quickplay is a UX failure mode. Disqualified.
- **Vercel / Netlify:** Function execution models aren't designed for long-lived WebSocket connections. Persistent multiplayer doesn't fit.
- **AWS Lambda + API Gateway WebSockets:** Function cold starts plus a heavy programming model for what should be a small game.
- **Keep-alive ping hacks on free tiers:** Unreliable, against TOS, and a player still occasionally hits a cold start. Ships a worse experience.

---

## Recommendation

**Build Phase 6 on Cloudflare Durable Objects, using PartyServer as the API layer.**

- Same UX as raw DO (edge proximity, per-room isolation, automatic scale)
- Faster to ship — keeps the focus on gameplay
- Frontend stays on Cloudflare (current setup), so the whole stack is one vendor with one dashboard
- D1 (Cloudflare's SQLite) for the leaderboard in Phase 8 — colocated with the rooms, no separate DB host

If the framework feels constraining or its trajectory wobbles, ejecting to raw DO is a small, contained refactor — the underlying primitive is identical.

### What changes about the project

- Phase 6: "Node + Socket.io server" → "Durable Object per room (via PartyServer) with WebSockets"
- `runner.js` event-emitter shape ports cleanly — same events, different transport
- Phase 9: "deploy to Render" → "deploy to Cloudflare" (already there)

### What to verify before committing

1. Spike a 10-line PartyServer instance that echoes WebSocket messages; deploy to Cloudflare; measure round-trip latency from a couple of geos
2. Confirm WebSocket Hibernation behavior (idle rooms shouldn't bill compute)
3. Confirm D1 read/write costs at expected leaderboard volume — should round to zero
4. Decide on room ID scheme (random ULIDs vs human-readable like `swift-blue-sparrow`) — affects the URL the player shares with friends

---

## Decision

_(To be filled in by Albert)_

**Selected option:**
**Date:**
**Notes:**
