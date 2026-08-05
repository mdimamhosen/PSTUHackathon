# Intelligent Emergency Response & Resource Optimization Platform

Country-scale NestJS backend that continuously ingests emergency incidents from multiple regions, allocates ambulances / hospitals / rescue teams / helicopters / EOCs, re-optimizes when the environment changes, and explains decisions with a RAG Agentic AI layer.

| | |
|---|---|
| **Repository** | [https://github.com/mdimamhosen/PSTUHackathon](https://github.com/mdimamhosen/PSTUHackathon) |
| **Swagger (local)** | [http://localhost:3000/docs](http://localhost:3000/docs) |
| **Default API key** | `change-me-demo-api-key` (header `x-api-key`) |

---

## Table of contents

0. [Problem statement](#0-problem-statement) · [Objectives → our solution](#objectives--how-we-satisfy-them) · [What we built vs extras](#what-we-built-vs-what-we-added-extra)
1. [Features](#1-features)
2. [Tech stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Decision & optimization algorithms](#4-decision--optimization-algorithms)
5. [Data model](#5-data-model)
6. [Setup](#6-setup)
7. [Environment variables](#7-environment-variables)
8. [Swagger](#8-swagger)
9. [API reference](#9-api-reference)
10. [WebSocket realtime](#10-websocket-realtime)
11. [Notifications](#11-notifications)
12. [Reliability, scale, security](#12-reliability-scale-security)
13. [Demo script (judges)](#13-demo-script-judges)
14. [Project structure](#14-project-structure)
15. [Scripts](#15-scripts)
16. [Troubleshooting](#16-troubleshooting)

---

## 0. Problem statement

> **Hackathon challenge — Intelligent Emergency Response & Resource Optimization Platform**

Design a backend system capable of managing and optimizing emergency response operations for a **large-scale country-wide disaster management network**.

The platform must **continuously receive emergency incidents from multiple regions** while coordinating available emergency resources such as **ambulances, hospitals, rescue teams, helicopters, and emergency operation centers**.

### Incident characteristics (required)

| Characteristic | How we model it |
|----------------|-----------------|
| Geographic location | `Incident.lat` / `Incident.lng` |
| Severity level | `severity` 1–5 + `priorityScore` |
| Number of affected people | `affectedCount` |
| Time sensitivity | `timeSensitivity` |
| Resource requirements | `resourceNeeds` JSON (types, etc.) |
| Environmental condition | `environment` JSON + `disasterType` |

### Resource dynamic properties (required)

| Property | How we model it |
|----------|-----------------|
| Current location | `Resource.lat` / `lng` |
| Availability | `status` (`AVAILABLE`, `RESERVED`, `BUSY`, `MAINTENANCE`, `FAILED`) |
| Capacity | `capacity` / `remainingCapacity` |
| Estimated travel time | Maps / Dijkstra / Haversine → `DispatchAssignment.etaMinutes` |
| Operational constraints | `constraints` JSON |
| Temporary failures / maintenance | `POST /resources/:id/fail`, `MAINTENANCE` / `FAILED` + reopt |

### Changing environment (required)

New requests may arrive anytime; roads may become unavailable; hospitals may fill; vehicles may fail; communication delays may occur; availability may change unexpectedly.

**Our response:** BullMQ streaming ingest + `POST /events` + region-scoped continuous reoptimization (Hungarian) + circuit breakers / fail-soft integrations.

### Judging expectations for the solution

The system must continuously make **near-optimal**, **explainable**, and **operationally feasible** decisions while adapting in **near real time**, remaining **reliable, scalable, fault tolerant, and maintainable** under heavy load.

---

### Objectives → how we satisfy them

| Objective | Our implementation |
|-----------|-------------------|
| Accept continuous stream of emergency events | `POST /incidents` + Redis/BullMQ backpressure + idempotency keys |
| Prioritize incidents intelligently | Weighted `priorityScore` + critical job priority (severity ≥ 4) |
| Allocate the most appropriate resources | Spatial prune + min travel-time cost + type/capacity/constraints |
| Continuously re-optimize when environment changes | `POST /events` / resource fail → `region.reopt` (Hungarian) |
| Minimize overall response time | Objective = minimize Σ ETA (Maps / Dijkstra shortest-**time**) |
| Maximize resource utilization | Capacity-fit in scoring; track `%` on `/metrics` |
| Prevent resource conflicts | Prisma TX + `Resource.version` optimistic locks + unique assignment roles |
| Remain operational when parts unavailable | Circuit breakers; Maps→Dijkstra/Haversine; LLM→algo explain; notify skip |
| Scale with users / incidents / resources | Stateless API/worker replicas, region-sharded jobs, Redis cache |

### Functional expectations → where justified

| Expectation | Covered in |
|-------------|------------|
| Overall system architecture | [§3 Architecture](#3-architecture) |
| Data flow | [§3 Data flow](#data-flow) |
| Service interactions | [§3](#3-architecture) + queues table |
| Decision-making strategy | [§4](#4-decision--optimization-algorithms) |
| Optimization approach | [§4](#4-decision--optimization-algorithms) + `GET /optimization/strategy` |
| Failure recovery strategy | [§12](#12-reliability-scale-security) |
| Scalability strategy | [§12](#12-reliability-scale-security) |
| Performance considerations | Hot/cold path + metrics + load-smoke |
| Security considerations | [§12](#12-reliability-scale-security) |
| Monitoring and observability | `/health`, `/metrics`, agent/optimization runs |
| Database design | [§5 Data model](#5-data-model) |
| Caching strategy | [§12 Caching](#caching) |
| Event processing strategy | BullMQ queues in [§3](#queues) |

Every important choice is justified in the sections below (modular NestJS + worker, hybrid algo+AI, Hungarian/Dijkstra, Docker, fail-soft keys, etc.).

---

### What we built vs what we added extra

#### Required by the problem (delivered)

- Multi-region continuous incident ingest and resource coordination (ambulance, hospital, rescue, helicopter, EOC)
- Incident + resource dynamic attributes as specified
- Near-real-time decisions under changing conditions (events, failures, capacity)
- Prioritization, allocation, continuous re-optimization
- Minimize response time, utilization awareness, conflict prevention
- High-throughput, reliable, scalable, fault-tolerant backend design
- Clear architecture / data flow / optimization / recovery / scale / security / DB / cache / events (this README + live `/optimization/strategy`)

#### Extra we added (differentiators for 1st place)

| Extra | Why it helps win |
|-------|------------------|
| **RAG Agentic AI** (Triage → Planner → Validator → Explainer) with **huge grounded system prompts** + hybrid multi-query retrieval | Explainable decisions with **SOP citations**, not black-box AI |
| **Hot path vs cold path** | Life-saving assign never waits on LLM |
| **Spatial grid + Dijkstra shortest-time + Hungarian matching** | Named, scalable algorithms judges can probe |
| **Google Maps ETA** with Dijkstra/Haversine fallback | Real roads when keyed; still works offline |
| **Claude + OpenAI** (agents + embeddings) | Production-shaped AI with soft degrade |
| **Telegram free phone alerts** (+ email / optional Twilio) | Mobile EOC notify without paid SMS |
| **Swagger UI** at `/docs` | Instant judge demo surface |
| **Chaos simulator** `POST /simulation/chaos` | Live proof of reopt under cascading failure |
| **WebSocket agent traces** | Watch decisions happen in real time |
| **`/health` + `/metrics`** | Observability baked in |
| **Full Docker Compose** (api + worker + Postgres + Redis) | One-command reproducible demo |
| **Bangladesh region seed + SOP knowledge corpus** | Ready-to-run national-scale story |
| **Load-smoke script** | Throughput narrative under burst ingest |
| **Idempotency + load shedding + API key security** | Production hygiene beyond the brief |

---

## 1. Features

### Multi-region continuous ingest
EOCs and region gateways can flood the platform with incidents at any time. Each `POST /incidents` is validated, persisted as `PENDING`, scored for priority, and enqueued to BullMQ within milliseconds. Optional `idempotencyKey` prevents duplicate disasters from double-consuming scarce resources. Under extreme load, queue-depth checks return `503` (load shedding) so the system stays healthy instead of collapsing.

### Resource coordination (national asset pool)
The system tracks live pools of **ambulances, hospitals, rescue teams, helicopters, and EOCs** per region. Every unit carries location, availability status (`AVAILABLE` / `RESERVED` / `BUSY` / `MAINTENANCE` / `FAILED`), capacity / remaining capacity, and operational constraints (e.g. weather-sensitive helicopters). Assignments reserve capacity transactionally so two incidents cannot book the same bed or vehicle.

### Min response-time optimization
Dispatch is not “nearest on a map” alone — the objective is **minimize travel time in minutes**. Candidates are pruned with a **spatial grid**, then timed via **Google Maps Distance Matrix** when configured, else **Dijkstra shortest-time** on a region road mesh that skips blocked cells, else Haversine. A cost function blends ETA with type match and constraints; greedy min-cost + type diversity picks the operationally best set for streaming incidents.

### Hungarian batch reoptimization
When the world changes mid-operation, a region can re-solve many pending incidents together using the **Kuhn–Munkres (Hungarian)** algorithm. The cost matrix is travel minutes (resource → incident); the matcher globally minimizes **Σ ETA** under capacity, then commits with optimistic locks. That is how we stay near-optimal after cascading failures, not just greedy one-by-one.

### Hot path vs cold path
**Hot path (life-saving):** ingest → queue → algorithmic assign → DB commit (milliseconds).  
**Cold path (trust & audit):** RAG agents + LLM narrative + Telegram/email (seconds, async).  
If Claude/OpenAI/Maps/Telegram are down, dispatch still completes. AI never gates an ambulance.

### RAG Agentic AI (explainable decisions)
After assignment, a bounded agent pipeline runs with **strong citation-first system prompts**:
1. **Triage** — refines severity/urgency from SOPs (JSON, grounded)  
2. **Planner** — binds to optimizer facts only (cannot invent resources)  
3. **Validator** — APPROVE / WARN / FLAG against protocols  
4. **Explainer** — operator-ready rationale with `[chunk:ID]` citations  

Claude is primary; OpenAI is fallback; algorithmic bullets if both fail. Traces live on `GET /incidents/:id/agent-run` and WebSocket `agent.step` events.

### Hybrid RAG knowledge layer
SOP corpus (flood, cyclone, fire, earthquake, hospital surge, utilization, reopt dynamics, BD EOC playbook) is chunked and searched with **query rewrite + embedding/keyword fusion**. `POST /rag/query` returns a grounded natural-language answer plus retrieved chunks — useful for judges and EOC operators asking protocol questions without touching live dispatch locks.

### Environment events & continuous adaptation
`POST /events` models the chaotic field: `ROAD_BLOCKED`, `HOSPITAL_FULL`, `VEHICLE_FAILED`, `WEATHER_HAZARD`, `COMMS_DELAY`, `CAPACITY_CHANGE`. Events invalidate ETA/route caches and enqueue region reopt (immediate for critical failures, lightly delayed for softer signals like COMMS_DELAY). Vehicle failure releases active assignments before rematch.

### Chaos simulator (demo weapon)
`POST /simulation/chaos` bursts many incidents across regions and can fail vehicles / block roads in one call. Judges can watch metrics, dispatches, and reopt react live — proof the platform handles cascading disasters, not only happy-path CRUD.

### Realtime WebSocket feeds
Socket.IO namespace `/realtime` lets dashboards join rooms `region:{id}`, `incident:{id}`, `agent:{incidentId}` and stream `assignment`, `agent.step`, and `environment` events. Redis adapter supports multi-instance API scale-out so subscribers are not stuck to one process.

### Multi-channel alerts (fail-soft)
Critical severity and major reopt releases fan out through:
- **Telegram** (free mobile push — primary demo channel)  
- **Email** via Nodemailer when SMTP is configured  
- **SMS** via Twilio when trial credentials exist  

Missing credentials skip that channel only; others still fire. No crash if Telegram/SMTP/Twilio is unset.

### Observability & audit trail
- `GET /health` — DB/Redis, queue depths, which integrations are configured, Maps circuit state  
- `GET /metrics` — ingest count, assign latency, reopt/Hungarian runs, RAG hits, utilization %, status breakdowns  
- Persisted `OptimizationRun`, `AgentRun` / `AgentStep`, and assignment explanations for after-action review  

### Docker one-command national demo
`docker compose up --build` starts **API + worker + Postgres + Redis** with migrations/seed. Scale with `--scale api=N --scale worker=M`. Same image, two commands — production-shaped packaging for hackathon reproducibility.

### Security & API hygiene
Mutating routes require `x-api-key`. Helmet, CORS, ValidationPipe (whitelist), and throttling protect the ingest surface. Secrets stay in env (`.env` is gitignored). Manual overrides are auditable with actor/reason.

### Swagger-first developer experience
Interactive OpenAPI at `/docs` documents every DTO and endpoint so judges can exercise the full lifecycle without Postman setup.

---

## 2. Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js, NestJS, TypeScript |
| API docs | Swagger (`@nestjs/swagger`) at `/docs` |
| Database | PostgreSQL + Prisma ORM |
| Queue / cache | Redis + BullMQ |
| Realtime | Socket.IO (+ Redis adapter for multi-instance) |
| Routing / ETA | Google Maps Distance Matrix; Dijkstra mesh fallback; Haversine last resort |
| AI | Anthropic Claude (agents), OpenAI (embeddings + LLM fallback) |
| RAG | Knowledge markdown corpus + cosine retrieval (embeddings when OpenAI key set) |
| Alerts | Telegram Bot API, Nodemailer, optional Twilio |
| Packaging | Docker + Docker Compose (`api`, `worker`, `postgres`, `redis`) |

---

## 3. Architecture

### Processes

- **`api`** — HTTP + WebSocket + enqueue jobs (no heavy processors in production compose)
- **`worker`** — BullMQ consumers: dispatch, reopt, agent, notify
- **Postgres** — durable state
- **Redis** — queues, ETA cache, Socket.IO adapter

### Hot path vs cold path

```
Incident POST → validate → persist PENDING → enqueue (ms)
       ↓ worker hot path
Spatial prune → min travel time → TX reserve/assign
       ↓ cold path (async)
RAG agents → LLM explanation + citations → Telegram/email
```

AI never blocks life-saving dispatch. If Maps/LLM/Telegram are down, hot path still completes.

### Data flow

1. Region/EOC calls `POST /incidents` (optional `idempotencyKey`)
2. API scores priority, writes row, enqueues `incident.dispatch` (priority 1 if severity ≥ 4)
3. Worker matches resources, commits assignments with optimistic locking (`Resource.version`)
4. Worker enqueues `incident.agent` + critical `notify.alert`
5. `POST /events` invalidates routing caches and enqueues `region.reopt` (coalesced per region)

### Queues

| Queue | Purpose |
|-------|---------|
| `incident.dispatch` | Hot-path assign |
| `region.reopt` | Region batch reoptimization |
| `incident.agent` | Cold-path RAG agents |
| `notify.alert` | Multi-channel alerts |

---

## 4. Decision & optimization algorithms

**Objective:** minimize total emergency response time (Σ ETA minutes), not raw distance.

| Layer | Algorithm | Role |
|-------|-----------|------|
| Candidate search | Uniform **spatial grid** | O(k) neighbors vs O(N) scan |
| Routing | **Google Maps** or **Dijkstra shortest-time** (binary heap) on region mesh | Avoid blocked roads; minimize minutes |
| Streaming assign | Greedy **min-cost** + type diversity | Fast path under continuous stream |
| Batch reopt | **Hungarian (Kuhn–Munkres)** min-cost bipartite matching | Globally optimal Σ ETA for region window |

Live machine-readable summary: `GET /optimization/strategy` (public).

Dispatch explanations include tags like `spatial-grid+min-time(dijkstra)` or `hungarian_min_cost`.

---

## 5. Data model

Core Prisma models:

- **Region** — bounds, EOC email / Telegram chat
- **Incident** — lat/lng, severity 1–5, affectedCount, timeSensitivity, resourceNeeds, environment, priorityScore, status, idempotencyKey
- **Resource** — type, lat/lng, capacity, remainingCapacity, status, version, constraints
- **DispatchAssignment** — ETA, score, scoreBreakdown, explanation, citations, status
- **EnvironmentEvent** — ROAD_BLOCKED, HOSPITAL_FULL, VEHICLE_FAILED, etc.
- **OptimizationRun** — snapshot, scores, latency, trigger
- **KnowledgeDocument / KnowledgeChunk** — RAG corpus
- **AgentRun / AgentStep** — agent traces
- **MetricCounter** — durable metrics keys

Resource types: `AMBULANCE | HOSPITAL | RESCUE_TEAM | HELICOPTER | EOC`  
Incident status: `PENDING | ASSIGNED | IN_PROGRESS | RESOLVED | CANCELLED`

Seeded demo regions: **all Bangladesh districts + cities** from [`countrycity-js`](https://www.npmjs.com/package/countrycity-js) (typically **70+ regions** and **hundreds of resources**, plus sample incidents). Override with `SEED_COUNTRY`, `SEED_MAX_REGIONS`, `SEED_INCIDENTS`.

---

## 6. Setup

### Option A — Docker (recommended for judges)

```bash
cp .env.example .env
# Optional: set GOOGLE_MAPS_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY,
# TELEGRAM_BOT_TOKEN, TELEGRAM_EOC_CHAT_ID, SMTP_*, TWILIO_*

docker compose up --build
```

- API + Swagger: http://localhost:3000/docs  
- Health: http://localhost:3000/health  
- Default API key: `change-me-demo-api-key` (header `x-api-key`)

Scale out:

```bash
docker compose up --build --scale api=2 --scale worker=3
```

Host port mappings (avoid local conflicts): Postgres `55432→5432`, Redis `56379→6379`. Inside Compose, services use internal hostnames `postgres` / `redis`.

### Option B — Local Node + Docker only for infra

```bash
docker compose up -d postgres redis
cp .env.example .env
npm install
npx prisma migrate dev
npm run seed
npm run start:dev          # terminal 1 — API
npm run start:worker       # terminal 2 — workers
```

Production-like local:

```bash
npm run build
npm run start:prod
npm run start:worker:prod
```

---

## 7. Environment variables

Copy from `.env.example`.

### Required for core dispatch

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (Compose sets for containers; local example uses port `55432`) |
| `REDIS_URL` | Redis (local example port `56379`) |
| `API_KEY` | Auth for mutating routes |

### Strongly recommended

| Variable | Purpose |
|----------|---------|
| `GOOGLE_MAPS_API_KEY` | Live road ETAs (enable Distance Matrix + Directions) |
| `ANTHROPIC_API_KEY` | Claude agents |
| `OPENAI_API_KEY` | RAG embeddings + LLM fallback |
| `TELEGRAM_BOT_TOKEN` | Free mobile alerts (`@BotFather`) |
| `TELEGRAM_EOC_CHAT_ID` | Destination chat/group id |

### Optional

| Variable | Purpose |
|----------|---------|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | SMS |
| `AGENT_TIMEOUT_MS` | Default `15000` |
| `EMBEDDING_MODEL` | Default `text-embedding-3-small` |
| `MAX_QUEUE_DEPTH` | Load-shed threshold (default `5000`) |
| `PORT` | Default `3000` |

**Fail-soft rule:** missing Maps / Claude / OpenAI / Telegram / SMTP / Twilio never crashes dispatch. Maps → Dijkstra/Haversine; LLM → algorithmic bullets; missing notify channel → skip that channel only.

---

## 8. Swagger

After start, open **http://localhost:3000/docs**.

- Interactive try-out for all REST endpoints  
- Use **Authorize** / header `x-api-key: change-me-demo-api-key`  
- Public routes (no key): `/health`, `/metrics`, `/regions`, `/optimization/strategy`  
- Schema models and DTOs are generated from Nest decorators + class-validator

OpenAPI document is also available from the Swagger UI JSON link on that page.

---

## 9. API reference

Base URL: `http://localhost:3000`  
Auth header (mutating routes): `x-api-key: <API_KEY>`

### Health & ops

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Public | DB, Redis, queue depths, integration flags, Maps circuit |
| GET | `/metrics` | Public | Ingest, assign latency, reopt, RAG hits, utilization, statuses |
| GET | `/optimization/strategy` | Public | Algorithm write-up for judges |

### Regions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/regions` | List seeded regions |
| GET | `/regions/:id` | Region detail |

### Incidents

| Method | Path | Description |
|--------|------|-------------|
| POST | `/incidents` | Create + enqueue dispatch |
| GET | `/incidents` | List (optional `?status=`) |
| GET | `/incidents/:id` | Detail + assignments + recent runs |
| GET | `/incidents/:id/agent-run` | Latest agent trace + citations |
| PATCH | `/incidents/:id` | Update severity/status (may trigger reopt) |

**POST `/incidents` body (example):**

```json
{
  "regionId": "<region cuid or use id from GET /regions>",
  "title": "Coastal cyclone surge",
  "lat": 22.35,
  "lng": 91.8,
  "severity": 5,
  "affectedCount": 80,
  "timeSensitivity": 5,
  "disasterType": "cyclone",
  "resourceNeeds": { "types": ["AMBULANCE", "RESCUE_TEAM", "HELICOPTER"] },
  "environment": { "hazard": 5, "weather": "storm" },
  "idempotencyKey": "optional-unique-key"
}
```

### Resources

| Method | Path | Description |
|--------|------|-------------|
| POST | `/resources` | Register resource |
| GET | `/resources/available` | Filter `?type=&regionId=` |
| PATCH | `/resources/:id` | Update location/status/capacity |
| POST | `/resources/:id/fail` | Mark failed → release + reopt |

### Environment events

| Method | Path | Description |
|--------|------|-------------|
| POST | `/events` | Disruptions → invalidate routing + reopt |
| GET | `/events` | Active events (`?regionId=`) |

**POST `/events` types:** `ROAD_BLOCKED`, `HOSPITAL_FULL`, `VEHICLE_FAILED`, `COMMS_DELAY`, `WEATHER_HAZARD`, `CAPACITY_CHANGE`

Example road block:

```json
{
  "regionId": "<regionId>",
  "type": "ROAD_BLOCKED",
  "payload": { "lat": 22.35, "lng": 91.82, "radiusKm": 3 }
}
```

### Dispatches

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dispatches` | Assignments with scores + explanations |
| POST | `/dispatches/:id/acknowledge` | Resource ack |
| POST | `/dispatches/override` | Manual override (audited) |

### RAG

| Method | Path | Description |
|--------|------|-------------|
| POST | `/rag/query` | `{ "query": "cyclone surge protocol" }` |
| POST | `/rag/ingest` | Add knowledge document |

### Simulation

| Method | Path | Description |
|--------|------|-------------|
| POST | `/simulation/chaos` | `{ "incidentCount": 30, "failResources": 3 }` |

---

## 10. WebSocket realtime

- Namespace: `/realtime`  
- Client event `join` with room string  
- Rooms: `region:{id}`, `incident:{id}`, `agent:{incidentId}`  
- Server events: `assignment`, `agent.step`, `environment`

---

## 11. Notifications

| Channel | When | Config |
|---------|------|--------|
| Telegram | Critical assign / reopt releases | `TELEGRAM_BOT_TOKEN`, chat id |
| Email | Same, if SMTP set | `SMTP_*` |
| SMS | Same, if Twilio + phone | `TWILIO_*` |

Create a bot with Telegram `@BotFather`, message it, read chat id, put values in `.env`.

---

## 12. Reliability, scale, security

### Failure recovery

| Failure | Behavior |
|---------|----------|
| Worker crash | BullMQ retry + idempotent assign |
| Maps down | Circuit breaker → Dijkstra / Haversine |
| LLM down | Algorithmic explanation; `llm.fallback` metric |
| Notify channel missing | Skip channel |
| Resource fail | Release assignment + reopt |
| Overload | `503` when queue depth > `MAX_QUEUE_DEPTH` |

### Scalability

- Stateless API/worker replicas  
- Region-coalesced reopt job ids (`reopt-{regionId}`)  
- Critical vs standard job priority  
- Redis ETA cache (TTL ~45s) + L1 memory  
- Short DB transactions + resource versioning  

### Security

- Helmet, CORS, ValidationPipe (`whitelist` + `forbidNonWhitelisted`)  
- API key guard on mutating routes  
- Throttling (Nest Throttler)  
- Secrets via env only (never commit `.env`)  

### Caching

- L1 in-process ETA  
- L2 Redis ETA  
- Dijkstra mesh cache per region (invalidated on environment events)  

---

## 13. Demo script (judges)

1. `docker compose up --build` → open http://localhost:3000/docs  
2. `GET /health`, `GET /regions`, `GET /optimization/strategy`  
3. `POST /incidents` severity 5 cyclone → wait ~2s → `GET /incidents/:id` and `GET /incidents/:id/agent-run`  
4. `POST /simulation/chaos` → `GET /metrics` + `GET /dispatches`  
5. `POST /rag/query` with cyclone protocol question  
6. Kill-switch story: without LLM keys, dispatch still works with algorithmic explanations  

Load smoke (optional):

```bash
API_URL=http://localhost:3000 API_KEY=change-me-demo-api-key npm run load-smoke
```

---

## 14. Project structure

```
├── Dockerfile
├── docker-compose.yml
├── docker/                 # entrypoint, pgvector init
├── prisma/                 # schema + migrations
├── knowledge/              # SOP corpus for RAG seed
├── scripts/                # seed.ts, load-smoke.ts
├── src/
│   ├── main.ts             # API entry
│   ├── worker.ts           # Worker entry
│   ├── config/
│   ├── prisma/
│   └── modules/            # regions, incidents, resources, events,
│                           # dispatch, optimization (algorithms),
│                           # maps, rag, agents, notifications,
│                           # realtime, simulation, metrics, health, queues
├── .env.example
└── README.md               # this file (single source of truth)
```

---

## 15. Scripts

| Command | Description |
|---------|-------------|
| `npm run start:dev` | API watch mode |
| `npm run start:worker` | Worker (ts-node) |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | `node dist/main.js` |
| `npm run start:worker:prod` | `node dist/worker.js` |
| `npm run seed` | Huge BD seed via `countrycity-js` (~135 regions, ~1500+ resources, 120 incidents) |
| `npm run load-smoke` | Concurrent ingest stress |

Prisma:

```bash
npx prisma migrate dev
npx prisma studio
```

---

## 16. Troubleshooting

| Issue | Fix |
|-------|-----|
| Port 3000 in use | Stop the old process or `PORT=3001 npm run start:prod` |
| Port 5432/6379 busy | Compose already maps `55432` / `56379` — use those in local `.env` |
| Jobs not assigning | Ensure **worker** is running (`worker` service or `npm run start:worker`) |
| `401` on POST | Send `x-api-key` matching `API_KEY` |
| No RAG embeddings | Set `OPENAI_API_KEY` (keyword fallback still works without it) |
| Telegram silent | Bot token + chat id; user/group must have talked to the bot |

---

## Repository

**GitHub:** [https://github.com/mdimamhosen/PSTUHackathon](https://github.com/mdimamhosen/PSTUHackathon)

---

## License

Hackathon submission — PSTU Hackathon.
# PSTUHackathon
