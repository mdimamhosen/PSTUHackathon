/**
 * Huge national seed using countrycity-js (Bangladesh districts + cities).
 * Creates ~70+ regions and hundreds of emergency resources.
 *
 * Env knobs:
 *   SEED_COUNTRY=BD          (ISO2, default BD)
 *   SEED_MAX_REGIONS=0       (0 = all districts/cities)
 *   SEED_INCIDENTS=120       (sample historical/pending incidents)
 */
import { PrismaClient, ResourceType, IncidentStatus, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import {
  getStatesOfCountry,
  getCitiesOfState,
  getCountryByCode,
} from 'countrycity-js';

const prisma = new PrismaClient();

const COUNTRY = (process.env.SEED_COUNTRY || 'BD').toUpperCase();
const MAX_REGIONS = parseInt(process.env.SEED_MAX_REGIONS || '0', 10);
const SAMPLE_INCIDENTS = parseInt(process.env.SEED_INCIDENTS || '120', 10);

type Place = {
  code: string;
  name: string;
  lat: number;
  lng: number;
  kind: 'district' | 'city';
  parent?: string;
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function parseCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

async function asList<T>(value: unknown): Promise<T[]> {
  const resolved = await Promise.resolve(value);
  if (Array.isArray(resolved)) return resolved as T[];
  if (resolved && typeof resolved === 'object') {
    return Object.values(resolved as Record<string, T>);
  }
  return [];
}

async function loadPlaces(): Promise<Place[]> {
  const country = (await Promise.resolve(getCountryByCode(COUNTRY))) as {
    name?: string;
  } | null;
  console.log(
    `Loading geography for ${country?.name || COUNTRY} via countrycity-js...`,
  );

  const states = await asList<Record<string, unknown>>(
    getStatesOfCountry(COUNTRY),
  );
  const places: Place[] = [];
  const seen = new Set<string>();

  for (const st of states) {
    const lat = parseCoord(st.latitude);
    const lng = parseCoord(st.longitude);
    if (lat == null || lng == null) continue;
    const code = `D${String(st.iso2 || st.id).padStart(2, '0')}`;
    if (seen.has(code)) continue;
    seen.add(code);
    places.push({
      code,
      name: String(st.name),
      lat,
      lng,
      kind: 'district',
    });

    const cities = await asList<Record<string, unknown>>(
      getCitiesOfState(COUNTRY, String(st.iso2)),
    );
    for (const city of cities) {
      const clat = parseCoord(city.latitude);
      const clng = parseCoord(city.longitude);
      if (clat == null || clng == null) continue;
      const cityCode = `C${city.id || slug(String(city.name))}`.slice(0, 24);
      if (seen.has(cityCode)) continue;
      if (
        city.name === st.name &&
        Math.abs(clat - lat) < 0.01 &&
        Math.abs(clng - lng) < 0.01
      ) {
        continue;
      }
      seen.add(cityCode);
      places.push({
        code: cityCode,
        name: `${String(city.name)} (${String(st.name)})`,
        lat: clat,
        lng: clng,
        kind: 'city',
        parent: String(st.name),
      });
    }
  }

  places.sort((a, b) => a.name.localeCompare(b.name));
  const limited = MAX_REGIONS > 0 ? places.slice(0, MAX_REGIONS) : places;
  console.log(
    `Places loaded: ${limited.length} (districts+cities) from ${states.length} admin units`,
  );
  return limited;
}

function resourceSpecs(
  code: string,
  scale: number,
): { name: string; type: ResourceType; capacity: number }[] {
  const ambulances = 3 + Math.min(6, scale);
  const rescues = 2 + Math.min(3, Math.floor(scale / 2));
  const specs: { name: string; type: ResourceType; capacity: number }[] = [];

  for (let i = 1; i <= ambulances; i++) {
    specs.push({
      name: `${code} Ambulance-${i}`,
      type: 'AMBULANCE',
      capacity: 1,
    });
  }
  specs.push({
    name: `${code} General Hospital`,
    type: 'HOSPITAL',
    capacity: 15 + scale * 5,
  });
  specs.push({
    name: `${code} Trauma Center`,
    type: 'HOSPITAL',
    capacity: 8 + scale * 2,
  });
  for (let i = 1; i <= rescues; i++) {
    specs.push({
      name: `${code} Rescue-${i}`,
      type: 'RESCUE_TEAM',
      capacity: 2,
    });
  }
  specs.push({
    name: `${code} Medevac Heli`,
    type: 'HELICOPTER',
    capacity: 1,
  });
  specs.push({
    name: `${code} EOC`,
    type: 'EOC',
    capacity: 5,
  });
  return specs;
}

const DISASTER_TYPES = [
  'flood',
  'cyclone',
  'fire',
  'earthquake',
  'medical',
  'rescue',
] as const;

async function main() {
  console.log('Seeding HUGE national dataset...');
  const places = await loadPlaces();
  if (!places.length) {
    throw new Error(
      `No places with coordinates for country ${COUNTRY}. Check countrycity-js data.`,
    );
  }

  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.optimizationRun.deleteMany();
  await prisma.dispatchAssignment.deleteMany();
  await prisma.environmentEvent.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeDocument.deleteMany();
  await prisma.region.deleteMany();

  const regionIds: { id: string; lat: number; lng: number; name: string }[] =
    [];
  let resourceCount = 0;

  for (let idx = 0; idx < places.length; idx++) {
    const p = places[idx];
    const pad = 0.12;
    const region = await prisma.region.create({
      data: {
        code: p.code.slice(0, 32),
        name: p.name.slice(0, 120),
        minLat: p.lat - pad,
        maxLat: p.lat + pad,
        minLng: p.lng - pad,
        maxLng: p.lng + pad,
        eocEmail: `eoc.${slug(p.name)}@emergency.${COUNTRY.toLowerCase()}.example`,
        telegramChatId: process.env.TELEGRAM_EOC_CHAT_ID || null,
      },
    });
    regionIds.push({
      id: region.id,
      lat: p.lat,
      lng: p.lng,
      name: p.name,
    });

    const scale = p.kind === 'district' ? 3 : 1;
    const specs = resourceSpecs(p.code, scale);
    const resourceRows = specs.map((s) => ({
      regionId: region.id,
      name: s.name,
      type: s.type,
      lat: p.lat + (Math.random() - 0.5) * 0.1,
      lng: p.lng + (Math.random() - 0.5) * 0.1,
      capacity: s.capacity,
      remainingCapacity: s.capacity,
      status: 'AVAILABLE' as const,
      constraints: {
        ...(s.type === 'HELICOPTER'
          ? { weatherSensitive: true }
          : { maxSeverity: 5 }),
        placeKind: p.kind,
      } as Prisma.InputJsonValue,
    }));

    const result = await prisma.resource.createMany({ data: resourceRows });
    resourceCount += result.count;

    if ((idx + 1) % 20 === 0 || idx === places.length - 1) {
      console.log(
        `  regions ${idx + 1}/${places.length}, resources so far ~${resourceCount}`,
      );
    }
  }

  const incidentCount = Math.min(SAMPLE_INCIDENTS, regionIds.length * 3);
  console.log(`Seeding ${incidentCount} sample incidents...`);
  for (let i = 0; i < incidentCount; i++) {
    const region = regionIds[i % regionIds.length];
    const severity = 1 + (i % 5);
    const disasterType = DISASTER_TYPES[i % DISASTER_TYPES.length];
    const status: IncidentStatus =
      i % 7 === 0
        ? 'RESOLVED'
        : i % 5 === 0
          ? 'IN_PROGRESS'
          : i % 3 === 0
            ? 'ASSIGNED'
            : 'PENDING';

    await prisma.incident.create({
      data: {
        regionId: region.id,
        title: `${disasterType.toUpperCase()} event near ${region.name} #${i + 1}`,
        description: `Seeded ${disasterType} scenario for load/demo in ${region.name}`,
        lat: region.lat + (Math.random() - 0.5) * 0.08,
        lng: region.lng + (Math.random() - 0.5) * 0.08,
        severity,
        affectedCount: 5 + (i % 90),
        timeSensitivity: severity,
        disasterType,
        resourceNeeds: {
          types:
            disasterType === 'flood' || disasterType === 'rescue'
              ? ['RESCUE_TEAM', 'AMBULANCE', 'HELICOPTER']
              : disasterType === 'fire'
                ? ['RESCUE_TEAM', 'AMBULANCE']
                : ['AMBULANCE', 'HOSPITAL'],
        },
        environment: {
          hazard: severity,
          weather: disasterType === 'cyclone' ? 'storm' : 'clear',
        },
        priorityScore: severity * 12 + (i % 10),
        status,
        idempotencyKey: `seed-${COUNTRY}-${i}`,
      },
    });
  }

  const knowledgeDir = path.join(process.cwd(), 'knowledge');
  let knowledgeDocs = 0;
  let knowledgeChunks = 0;
  if (fs.existsSync(knowledgeDir)) {
    const files = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf8');
      const title = file.replace('.md', '');
      const disasterType = title.includes('flood')
        ? 'flood'
        : title.includes('cyclone')
          ? 'cyclone'
          : title.includes('fire')
            ? 'fire'
            : title.includes('earthquake')
              ? 'earthquake'
              : 'general';
      const doc = await prisma.knowledgeDocument.create({
        data: {
          title,
          source: file,
          content,
          disasterType,
          regionScope: COUNTRY,
        },
      });
      knowledgeDocs++;
      const chunkSize = 700;
      const chunkRows = [];
      for (let i = 0; i < content.length; i += chunkSize) {
        chunkRows.push({
          documentId: doc.id,
          content: content.slice(i, i + chunkSize),
          embedding: [] as number[],
          metadata: { title, disasterType },
        });
      }
      if (chunkRows.length) {
        const r = await prisma.knowledgeChunk.createMany({ data: chunkRows });
        knowledgeChunks += r.count;
      }
    }
  }

  console.log('========== SEED SUMMARY ==========');
  console.log(`Country:           ${COUNTRY}`);
  console.log(`Regions:           ${regionIds.length}`);
  console.log(`Resources:         ${resourceCount}`);
  console.log(`Sample incidents:  ${incidentCount}`);
  console.log(`Knowledge docs:    ${knowledgeDocs}`);
  console.log(`Knowledge chunks:  ${knowledgeChunks}`);
  console.log('==================================');
  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
