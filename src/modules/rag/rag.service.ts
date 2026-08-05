import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  RAG_QUERY_REWRITE_SYSTEM,
  RAG_QUERY_SYSTEM,
  buildRagContextBlock,
} from '../agents/prompts';

export type RagHit = {
  chunkId: string;
  documentId: string;
  content: string;
  title?: string;
  score: number;
  disasterType?: string | null;
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
    const chunks = chunkText(input.content, 700);
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

  /** Multi-query hybrid retrieval for an incident. */
  async searchForIncident(incident: {
    title: string;
    disasterType?: string | null;
    severity: number;
    affectedCount: number;
    environment?: unknown;
    resourceNeeds?: unknown;
  }): Promise<RagHit[]> {
    const base = [
      `${incident.disasterType || 'emergency'} severity ${incident.severity} ${incident.title} response protocol`,
      `${incident.disasterType || 'disaster'} resource dispatch ambulance hospital rescue helicopter`,
      `triage surge capacity time-critical affected ${incident.affectedCount}`,
    ];
    const env = incident.environment as { weather?: string } | null;
    if (env?.weather) {
      base.push(`${env.weather} weather helicopter constraints emergency`);
    }
    const needs = incident.resourceNeeds as { types?: string[] } | null;
    if (needs?.types?.length) {
      base.push(`${needs.types.join(' ')} allocation SOP`);
    }

    const rewritten = await this.rewriteQueries(
      `${incident.title} ${incident.disasterType || ''}`.trim(),
    );
    const queries = [...base, ...rewritten].slice(0, 6);

    const merged = new Map<string, RagHit>();
    for (const q of queries) {
      const hits = await this.search(q, 4, incident.disasterType || undefined);
      for (const h of hits) {
        const prev = merged.get(h.chunkId);
        if (!prev || h.score > prev.score) merged.set(h.chunkId, h);
      }
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  }

  async search(
    query: string,
    topK = 5,
    disasterType?: string,
  ): Promise<RagHit[]> {
    const qEmbed = await this.embed(query);
    const chunks = await this.prisma.knowledgeChunk.findMany({
      take: 300,
      include: { document: true },
      where: disasterType
        ? {
            OR: [
              { document: { disasterType } },
              { document: { disasterType: 'general' } },
              { document: { disasterType: null } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
    });
    if (!chunks.length) return [];

    const tokens = tokenize(query);
    const ranked: RagHit[] = chunks.map((c) => {
      const embScore =
        qEmbed?.length && c.embedding?.length
          ? cosine(qEmbed, c.embedding)
          : 0;
      const kwScore = keywordScore(c.content + ' ' + (c.document.title || ''), tokens);
      const typeBoost =
        disasterType && c.document.disasterType === disasterType ? 0.08 : 0;
      // Hybrid: embedding dominates when present; keywords fill gaps
      const score =
        (qEmbed?.length ? 0.72 * embScore + 0.28 * kwScore : kwScore) + typeBoost;
      return {
        chunkId: c.id,
        documentId: c.documentId,
        content: c.content,
        title: c.document.title,
        disasterType: c.document.disasterType,
        score,
      };
    });

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, topK);
    if (top.length) await this.metrics.incr('rag.hits');
    return top;
  }

  /** Grounded Q&A for operators / judges. */
  async answerQuery(query: string) {
    const rewritten = await this.rewriteQueries(query);
    const merged = new Map<string, RagHit>();
    for (const q of [query, ...rewritten]) {
      for (const h of await this.search(q, 5)) {
        const prev = merged.get(h.chunkId);
        if (!prev || h.score > prev.score) merged.set(h.chunkId, h);
      }
    }
    const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 6);
    const context = buildRagContextBlock(hits);

    let answer = '';
    if (this.openai) {
      try {
        const res = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.15,
          max_tokens: 900,
          messages: [
            { role: 'system', content: RAG_QUERY_SYSTEM },
            {
              role: 'user',
              content: `OPERATOR_QUESTION:\n${query}\n\n${context}\n\nAnswer now with citations.`,
            },
          ],
        });
        answer = res.choices[0]?.message?.content || '';
      } catch (err) {
        this.logger.warn(`RAG answer LLM failed: ${String(err)}`);
      }
    }

    if (!answer) {
      answer = [
        '## Direct answer',
        hits.length
          ? 'Retrieved protocol excerpts below (LLM answer unavailable — showing grounded chunks).'
          : 'No matching SOP chunks found in the knowledge base.',
        '',
        '## Citations',
        ...hits.map(
          (h) =>
            `- [chunk:${h.chunkId}] ${h.title || 'doc'}: ${h.content.slice(0, 240)}...`,
        ),
      ].join('\n');
    }

    return { enabled: this.enabled, answer, hits };
  }

  private async rewriteQueries(question: string): Promise<string[]> {
    if (!this.openai || question.length < 8) return [];
    try {
      const res = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: RAG_QUERY_REWRITE_SYSTEM },
          { role: 'user', content: question },
        ],
      });
      const text = res.choices[0]?.message?.content || '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end < 0) return [];
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        queries?: string[];
      };
      return (parsed.queries || []).filter((q) => typeof q === 'string').slice(0, 3);
    } catch {
      return [];
    }
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

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function keywordScore(text: string, tokens: string[]): number {
  if (!tokens.length) return 0.05;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits++;
  return hits / tokens.length;
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
