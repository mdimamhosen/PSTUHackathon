import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';

export type RagHit = {
  chunkId: string;
  documentId: string;
  content: string;
  title?: string;
  score: number;
};

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private openai: OpenAI | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {
    const key = this.config.get<string>('openaiApiKey');
    if (key) this.openai = new OpenAI({ apiKey: key });
  }

  get enabled() {
    return !!this.openai;
  }

  async ingestDocument(input: {
    title: string;
    source: string;
    content: string;
    disasterType?: string;
    regionScope?: string;
  }) {
    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        title: input.title,
        source: input.source,
        content: input.content,
        disasterType: input.disasterType,
        regionScope: input.regionScope,
      },
    });
    const chunks = chunkText(input.content, 800);
    for (const content of chunks) {
      const embedding = await this.embed(content);
      await this.prisma.knowledgeChunk.create({
        data: {
          documentId: doc.id,
          content,
          embedding: embedding || [],
          metadata: { title: input.title, disasterType: input.disasterType },
        },
      });
    }
    return doc;
  }

  async search(query: string, topK = 5): Promise<RagHit[]> {
    const qEmbed = await this.embed(query);
    const chunks = await this.prisma.knowledgeChunk.findMany({
      take: 200,
      include: { document: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!chunks.length) return [];

    let ranked: RagHit[];
    if (qEmbed?.length) {
      ranked = chunks
        .map((c) => ({
          chunkId: c.id,
          documentId: c.documentId,
          content: c.content,
          title: c.document.title,
          score: cosine(qEmbed, c.embedding || []),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    } else {
      const q = query.toLowerCase();
      ranked = chunks
        .map((c) => ({
          chunkId: c.id,
          documentId: c.documentId,
          content: c.content,
          title: c.document.title,
          score: c.content.toLowerCase().includes(q) ? 0.5 : 0.1,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }
    if (ranked.length) await this.metrics.incr('rag.hits');
    return ranked;
  }

  private async embed(text: string): Promise<number[] | null> {
    if (!this.openai) return null;
    try {
      const model = this.config.get<string>('embeddingModel')!;
      const res = await this.openai.embeddings.create({
        model,
        input: text.slice(0, 8000),
      });
      return res.data[0]?.embedding || null;
    } catch (err) {
      this.logger.warn(`Embedding failed: ${String(err)}`);
      return null;
    }
  }
}

function chunkText(text: string, size: number): string[] {
  const parts: string[] = [];
  const clean = text.replace(/\r/g, '').trim();
  for (let i = 0; i < clean.length; i += size) {
    parts.push(clean.slice(i, i + size));
  }
  return parts.length ? parts : [clean];
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
