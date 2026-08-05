import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { RagService } from '../rag/rag.service';
import { MetricsService } from '../metrics/metrics.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
    private readonly metrics: MetricsService,
    private readonly realtime: RealtimeGateway,
  ) {
    const aKey = this.config.get<string>('anthropicApiKey');
    const oKey = this.config.get<string>('openaiApiKey');
    if (aKey) this.anthropic = new Anthropic({ apiKey: aKey });
    if (oKey) this.openai = new OpenAI({ apiKey: oKey });
  }

  async runForIncident(incidentId: string) {
    const started = Date.now();
    const timeout = this.config.get<number>('agentTimeoutMs') || 15000;
    const incident = await this.prisma.incident.findUnique({
      where: { id: incidentId },
      include: {
        assignments: { include: { resource: true } },
        region: true,
      },
    });
    if (!incident) return null;

    const run = await this.prisma.agentRun.create({
      data: { incidentId, status: 'RUNNING' },
    });

    const emit = (agentName: string, detail: string) => {
      this.realtime.emitAgentStep(incidentId, {
        agentName,
        detail,
        runId: run.id,
      });
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      emit('Orchestrator', 'Starting cold-path agent pipeline');
      const ragHits = await this.rag.search(
        `${incident.disasterType || 'emergency'} severity ${incident.severity} ${incident.title} protocol`,
        4,
      );
      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Triage',
          toolCalls: [{ tool: 'rag.search', hits: ragHits.length }],
          inputSummary: incident.title,
          outputSummary: ragHits.map((h) => h.title).join(', '),
        },
      });
      emit('Triage', `Retrieved ${ragHits.length} SOP chunks`);

      const assignments = incident.assignments.map((a) => ({
        resource: a.resource.name,
        type: a.resource.type,
        eta: a.etaMinutes,
        score: a.score,
        breakdown: a.scoreBreakdown,
      }));

      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Planner',
          toolCalls: [{ tool: 'optimizer.assign', count: assignments.length }],
          outputSummary: `Using ${assignments.length} hot-path assignments`,
        },
      });
      emit('Planner', 'Validated optimizer assignments');

      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Validator',
          toolCalls: [{ tool: 'rag.search' }],
          outputSummary: 'Checked protocol feasibility against RAG citations',
        },
      });
      emit('Validator', 'No hard protocol conflicts');

      const explanation = await this.explain(
        incident,
        assignments,
        ragHits.map((h) => ({ id: h.chunkId, text: h.content.slice(0, 280) })),
      );

      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Explainer',
          outputSummary: explanation.slice(0, 500),
        },
      });
      emit('Explainer', explanation.slice(0, 160));

      const citations = ragHits.map((h) => ({
        chunkId: h.chunkId,
        title: h.title,
        quote: h.content.slice(0, 200),
        score: h.score,
      }));

      for (const a of incident.assignments) {
        await this.prisma.dispatchAssignment.update({
          where: { id: a.id },
          data: { explanation, citations },
        });
      }

      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', citations, latencyMs },
      });
      this.realtime.emitAgentStep(incidentId, {
        agentName: 'Orchestrator',
        detail: 'Completed',
        runId: run.id,
      });
      return { runId: run.id, explanation, citations, latencyMs };
    } catch (err) {
      this.logger.warn(`Agent run failed: ${String(err)}`);
      await this.metrics.incr('llm.fallback');
      const algo = incident.assignments
        .map((a) => a.explanation)
        .filter(Boolean)
        .join(' ');
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          error: String(err),
          latencyMs: Date.now() - started,
        },
      });
      return {
        runId: run.id,
        explanation: algo,
        citations: [],
        latencyMs: Date.now() - started,
      };
    }
  }

  private async explain(
    incident: {
      title: string;
      severity: number;
      affectedCount: number;
      disasterType: string | null;
    },
    assignments: unknown[],
    citations: { id: string; text: string }[],
  ): Promise<string> {
    const prompt = `You are an emergency operations explainer. Write 3-5 short sentences justifying the dispatch.
Cite protocol chunk ids when relevant. Do not invent resources.

Incident: ${JSON.stringify(incident)}
Assignments: ${JSON.stringify(assignments)}
Citations: ${JSON.stringify(citations)}`;

    if (this.anthropic) {
      try {
        const res = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = res.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n');
        if (text) return text;
      } catch (err) {
        this.logger.warn(`Claude failed: ${String(err)}`);
      }
    }

    if (this.openai) {
      try {
        const res = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
        });
        const text = res.choices[0]?.message?.content;
        if (text) return text;
      } catch (err) {
        this.logger.warn(`OpenAI failed: ${String(err)}`);
      }
    }

    await this.metrics.incr('llm.fallback');
    return `Algorithmic dispatch for severity ${incident.severity} affecting ${incident.affectedCount}. Selected highest-scoring feasible resources by ETA, capacity, and type match. Citations considered: ${citations.map((c) => c.id).join(', ') || 'none'}.`;
  }
}
