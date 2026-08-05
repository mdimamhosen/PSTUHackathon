/**
 * Load smoke: fire many concurrent incident creates against a running API.
 * Usage: API_URL=http://localhost:3000 API_KEY=... npx ts-node scripts/load-smoke.ts
 */
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'change-me-demo-api-key';
const TOTAL = parseInt(process.env.LOAD_COUNT || '200', 10);
const CONCURRENCY = parseInt(process.env.LOAD_CONCURRENCY || '25', 10);

async function main() {
  const regions = await axios.get(`${API_URL}/regions`, {
    headers: { 'x-api-key': API_KEY },
  });
  const regionList = regions.data as { id: string; minLat: number; maxLat: number; minLng: number; maxLng: number }[];
  if (!regionList.length) throw new Error('No regions — seed first');

  let ok = 0;
  let fail = 0;
  const started = Date.now();

  async function one(i: number) {
    const region = regionList[i % regionList.length];
    try {
      await axios.post(
        `${API_URL}/incidents`,
        {
          regionId: region.id,
          title: `Load smoke #${i}`,
          lat: region.minLat + Math.random() * (region.maxLat - region.minLat),
          lng: region.minLng + Math.random() * (region.maxLng - region.minLng),
          severity: 1 + (i % 5),
          affectedCount: 1 + (i % 30),
          timeSensitivity: 3,
          disasterType: 'medical',
          resourceNeeds: { types: ['AMBULANCE'] },
          idempotencyKey: `load-${Date.now()}-${i}`,
        },
        { headers: { 'x-api-key': API_KEY }, timeout: 10000 },
      );
      ok++;
    } catch {
      fail++;
    }
  }

  const queue = Array.from({ length: TOTAL }, (_, i) => i);
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const i = queue.shift();
      if (i === undefined) break;
      await one(i);
    }
  });
  await Promise.all(workers);

  const ms = Date.now() - started;
  console.log(
    JSON.stringify(
      {
        total: TOTAL,
        ok,
        fail,
        ms,
        throughputPerSec: Math.round((ok / ms) * 1000),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
