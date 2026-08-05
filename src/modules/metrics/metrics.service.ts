import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MetricsService {
  private memory = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async incr(key: string, by = 1) {
    this.memory.set(key, (this.memory.get(key) || 0) + by);
    try {
      await this.prisma.metricCounter.upsert({
        where: { key },
        create: { key, value: by },
        update: { value: { increment: by } },
      });
    } catch {
      // fail-soft
    }
  }

  async observe(key: string, value: number) {
    this.memory.set(key, value);
    try {
      await this.prisma.metricCounter.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    } catch {
      // fail-soft
    }
  }

  async snapshot() {
    let dbRows: { key: string; value: number }[] = [];
    try {
      dbRows = await this.prisma.metricCounter.findMany();
    } catch {
      dbRows = [];
    }
    const fromDb = Object.fromEntries(dbRows.map((r) => [r.key, r.value]));
    const mem = Object.fromEntries(this.memory.entries());
    return {
      ...fromDb,
      ...mem,
      ingestRate: mem['ingest.total'] || fromDb['ingest.total'] || 0,
      assignLatencyMs:
        mem['assign.latencyMs'] || fromDb['assign.latencyMs'] || 0,
      reoptCount: mem['reopt.total'] || fromDb['reopt.total'] || 0,
      conflictRetries:
        mem['assign.conflictRetries'] || fromDb['assign.conflictRetries'] || 0,
      ragHitRate: mem['rag.hits'] || fromDb['rag.hits'] || 0,
      llmFallbackCount: mem['llm.fallback'] || fromDb['llm.fallback'] || 0,
    };
  }
}
