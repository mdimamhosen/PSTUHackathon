# Intelligent Emergency Response & Resource Optimization Platform

Country-scale NestJS backend that continuously ingests emergency incidents from multiple regions, allocates ambulances / hospitals / rescue teams / helicopters / EOCs, re-optimizes when the environment changes, and explains decisions with a RAG Agentic AI layer.

---

## Table of contents

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

## 1. Features

- **Multi-region continuous ingest** — idempotent `POST /incidents`, priority queues, load shedding under overload
- **Resource coordination** — `AMBULANCE`, `HOSPITAL`, `RESCUE_TEAM`, `HELICOPTER`, `EOC` with capacity + status
- **Min response-time optimization** — spatial grid prune → Google Maps / Dijkstra shortest-time → min-cost assign
- **Hungarian batch reopt** — globally minimize Σ ETA when roads fail, vehicles fail, hospitals fill
- **Hot path vs cold path** — algorithmic dispatch in milliseconds; RAG agents explain after assign
- **RAG Agentic AI** — Triage → Planner → Validator → Explainer with SOP citations (Claude / OpenAI)
- **Environment events** — road blocks, hospital full, vehicle failure, weather → cache invalidate + reopt
- **Chaos simulator** — burst incidents + failures for live demos
- **Realtime** — Socket.IO rooms for regions, incidents, agent traces
- **Alerts** — Telegram (free), email (Nodemailer), optional Twilio SMS — all fail-soft
- **Observability** — `/health`, `/metrics`, persisted optimization + agent runs
- **Docker one-command demo** — API + worker + Postgres + Redis

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

Seeded demo regions: Dhaka (DAC), Chattogram (CTG), Khulna (KHL), Sylhet (SYL).

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
| `npm run seed` | Seed regions, resources, knowledge |
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

## License

Hackathon submission — PSTU Hackathon.
# PSTUHackathon
