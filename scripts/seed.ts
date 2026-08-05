import { PrismaClient, ResourceType } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const regions = [
  {
    code: 'DAC',
    name: 'Dhaka',
    minLat: 23.7,
    maxLat: 23.9,
    minLng: 90.3,
    maxLng: 90.5,
    eocEmail: 'eoc.dhaka@example.com',
  },
  {
    code: 'CTG',
    name: 'Chattogram',
    minLat: 22.2,
    maxLat: 22.4,
    minLng: 91.7,
    maxLng: 91.9,
    eocEmail: 'eoc.ctg@example.com',
  },
  {
    code: 'KHL',
    name: 'Khulna',
    minLat: 22.7,
    maxLat: 22.9,
    minLng: 89.5,
    maxLng: 89.7,
    eocEmail: 'eoc.khulna@example.com',
  },
  {
    code: 'SYL',
    name: 'Sylhet',
    minLat: 24.8,
    maxLat: 25.0,
    minLng: 91.8,
    maxLng: 92.0,
    eocEmail: 'eoc.sylhet@example.com',
  },
];

async function main() {
  console.log('Seeding regions/resources/knowledge...');
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

  for (const r of regions) {
    const region = await prisma.region.create({
      data: {
        ...r,
        telegramChatId: process.env.TELEGRAM_EOC_CHAT_ID || null,
      },
    });

    const centerLat = (r.minLat + r.maxLat) / 2;
    const centerLng = (r.minLng + r.maxLng) / 2;
    const specs: { name: string; type: ResourceType; capacity: number }[] = [
      { name: `${r.code} Ambulance-1`, type: 'AMBULANCE', capacity: 1 },
      { name: `${r.code} Ambulance-2`, type: 'AMBULANCE', capacity: 1 },
      { name: `${r.code} Ambulance-3`, type: 'AMBULANCE', capacity: 1 },
      { name: `${r.code} General Hospital`, type: 'HOSPITAL', capacity: 20 },
      { name: `${r.code} Trauma Center`, type: 'HOSPITAL', capacity: 10 },
      { name: `${r.code} Rescue Alpha`, type: 'RESCUE_TEAM', capacity: 2 },
      { name: `${r.code} Rescue Bravo`, type: 'RESCUE_TEAM', capacity: 2 },
      { name: `${r.code} Medevac Heli`, type: 'HELICOPTER', capacity: 1 },
      { name: `${r.code} EOC`, type: 'EOC', capacity: 5 },
    ];

    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      await prisma.resource.create({
        data: {
          regionId: region.id,
          name: s.name,
          type: s.type,
          lat: centerLat + (Math.random() - 0.5) * 0.08,
          lng: centerLng + (Math.random() - 0.5) * 0.08,
          capacity: s.capacity,
          remainingCapacity: s.capacity,
          status: 'AVAILABLE',
          constraints:
            s.type === 'HELICOPTER'
              ? { weatherSensitive: true }
              : { maxSeverity: 5 },
        },
      });
    }
  }

  const knowledgeDir = path.join(process.cwd(), 'knowledge');
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
              : title.includes('bangladesh') || title.includes('eoc')
                ? 'general'
                : title.includes('reoptimization') || title.includes('conflict')
                  ? 'general'
                  : 'general';
      const doc = await prisma.knowledgeDocument.create({
        data: {
          title,
          source: file,
          content,
          disasterType,
          regionScope: 'BD',
        },
      });
      const chunkSize = 700;
      for (let i = 0; i < content.length; i += chunkSize) {
        const chunk = content.slice(i, i + chunkSize);
        await prisma.knowledgeChunk.create({
          data: {
            documentId: doc.id,
            content: chunk,
            embedding: [],
            metadata: { title, disasterType },
          },
        });
      }
    }
  }

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
