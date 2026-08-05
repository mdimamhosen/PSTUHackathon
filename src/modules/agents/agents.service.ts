import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { RagService } from '../rag/rag.service';
import { MetricsService } from '../metrics/metrics.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  RAG_EXPLAINER_SYSTEM,
  RAG_ORCHESTRATOR_SYSTEM,
  RAG_TRIAGE_SYSTEM,
  RAG_VALIDATOR_SYSTEM,
  buildRagContextBlock,
} from './prompts';

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
    const timeout = this.config.get<number>('agentTimeoutMs') || 20000;
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
      const timer = setTimeout(() => undefined, timeout);

      emit('Orchestrator', 'Cold-path RAG agent pipeline started');

      // Multi-query RAG retrieval (strong coverage)
      const ragHits = await this.rag.searchForIncident({
        title: incident.title,
        disasterType: incident.disasterType,
        severity: incident.severity,
        affectedCount: incident.affectedCount,
        environment: incident.environment,
        resourceNeeds: incident.resourceNeeds,
      });
      await this.metrics.incr('rag.hits', ragHits.length || 1);

      const ragBlock = buildRagContextBlock(
        ragHits.map((h) => ({
          chunkId: h.chunkId,
          title: h.title,
          content: h.content,
          score: h.score,
        })),
      );

      const incidentPayload = {
        id: incident.id,
        title: incident.title,
        description: incident.description,
        lat: incident.lat,
        lng: incident.lng,
        severity: incident.severity,
        affectedCount: incident.affectedCount,
        timeSensitivity: incident.timeSensitivity,
        disasterType: incident.disasterType,
        environment: incident.environment,
        resourceNeeds: incident.resourceNeeds,
        priorityScore: incident.priorityScore,
        region: {
          code: incident.region.code,
          name: incident.region.name,
        },
      };

      const assignments = incident.assignments.map((a) => ({
        resource: a.resource.name,
        type: a.resource.type,
        etaMinutes: a.etaMinutes,
        score: a.score,
        breakdown: a.scoreBreakdown,
        status: a.status,
        capacity: a.resource.capacity,
        remainingCapacity: a.resource.remainingCapacity,
      }));

      // --- Triage Agent (LLM + RAG) ---
      emit('Triage', 'Running grounded triage against SOP corpus');
      const triageUser = `${RAG_ORCHESTRATOR_SYSTEM.slice(0, 400)}

INCIDENT_JSON:
${JSON.stringify(incidentPayload)}

${ragBlock}

Produce the triage JSON now.`;
      const triageRaw = await this.chat(RAG_TRIAGE_SYSTEM, triageUser, 700);
      const triage = safeJson(triageRaw) || {
        refinedSeverity: incident.severity,
        severityRationale: 'Fallback: using optimizer severity',
        urgencyClass:
          incident.severity >= 5
            ? 'IMMEDIATE'
            : incident.severity >= 4
              ? 'CRITICAL'
              : 'URGENT',
        requiredResourceTypes: [],
        hazards: [],
        protocolKeys: [],
        confidence: 0.3,
        citations: ragHits.map((h) => h.chunkId),
      };
      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Triage',
          toolCalls: [{ tool: 'rag.search', hits: ragHits.length }],
          inputSummary: incident.title,
          outputSummary: JSON.stringify(triage).slice(0, 1800),
        },
      });
      emit(
        'Triage',
        `severity→${triage.refinedSeverity} (${triage.urgencyClass}) conf=${triage.confidence}`,
      );

      // Soft-apply refined severity only if higher and confidence high (never invent lower)
      if (
        typeof triage.refinedSeverity === 'number' &&
        triage.refinedSeverity > incident.severity &&
        triage.refinedSeverity <= 5 &&
        (triage.confidence ?? 0) >= 0.55
      ) {
        await this.prisma.incident.update({
          where: { id: incident.id },
          data: { severity: triage.refinedSeverity },
        });
      }

      // --- Planner (binds to optimizer facts; no invent) ---
      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Planner',
          toolCalls: [
            { tool: 'optimizer.assign', count: assignments.length },
            { tool: 'objective', value: 'minimize_sum_eta' },
          ],
          outputSummary: `Bound ${assignments.length} hot-path assignments (algo owns locks)`,
        },
      });
      emit('Planner', 'Bound optimizer min-time assignments');

      // --- Validator Agent ---
      emit('Validator', 'Protocol + feasibility critique');
      const validatorUser = `INCIDENT_JSON:
${JSON.stringify(incidentPayload)}

TRIAGE_JSON:
${JSON.stringify(triage)}

ASSIGNMENTS_JSON:
${JSON.stringify(assignments)}

${ragBlock}

Validate feasibility and protocol alignment. Return JSON.`;
      const validatorRaw = await this.chat(
        RAG_VALIDATOR_SYSTEM,
        validatorUser,
        700,
      );
      const validation = safeJson(validatorRaw) || {
        verdict: 'APPROVE',
        feasibilityNotes: ['Fallback approve: algorithmic assignment retained'],
        protocolGaps: [],
        suggestedAdjustments: [],
        citations: ragHits.map((h) => h.chunkId),
        confidence: 0.35,
      };
      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Validator',
          toolCalls: [{ tool: 'rag.search' }],
          outputSummary: JSON.stringify(validation).slice(0, 1800),
        },
      });
      emit('Validator', `verdict=${validation.verdict}`);

      // --- Explainer Agent ---
      emit('Explainer', 'Writing citation-backed operator rationale');
      const explainerUser = `INCIDENT_JSON:
${JSON.stringify(incidentPayload)}

TRIAGE_JSON:
${JSON.stringify(triage)}

VALIDATION_JSON:
${JSON.stringify(validation)}

ASSIGNMENTS_JSON:
${JSON.stringify(assignments)}

${ragBlock}

Write the operator explanation now.`;
      let explanation = await this.chat(
        `${RAG_ORCHESTRATOR_SYSTEM}\n\n${RAG_EXPLAINER_SYSTEM}`,
        explainerUser,
        900,
      );
      if (!explanation?.trim()) {
        await this.metrics.incr('llm.fallback');
        explanation = this.algoFallback(incident, assignments, ragHits);
      }

      await this.prisma.agentStep.create({
        data: {
          runId: run.id,
          agentName: 'Explainer',
          outputSummary: explanation.slice(0, 2000),
        },
      });
      emit('Explainer', explanation.slice(0, 160));

      const citations = ragHits.map((h) => ({
        chunkId: h.chunkId,
        title: h.title,
        quote: h.content.slice(0, 220),
        score: h.score,
      }));

      for (const a of incident.assignments) {
        await this.prisma.dispatchAssignment.update({
          where: { id: a.id },
          data: {
            explanation,
            citations: {
              triage,
              validation,
              chunks: citations,
            },
          },
        });
      }

      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          citations: { triage, validation, chunks: citations },
          latencyMs,
        },
      });
      this.realtime.emitAgentStep(incidentId, {
        agentName: 'Orchestrator',
        detail: 'Completed',
        runId: run.id,
      });
      return { runId: run.id, explanation, citations, latencyMs, triage, validation };
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

  private async chat(
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<string> {
    if (this.anthropic) {
      try {
        const res = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        });
        const text = res.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n');
        if (text?.trim()) return text;
      } catch (err) {
        this.logger.warn(`Claude failed: ${String(err)}`);
      }
    }

    if (this.openai) {
      try {
        const res = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.2,
        });
        const text = res.choices[0]?.message?.content;
        if (text?.trim()) return text;
      } catch (err) {
        this.logger.warn(`OpenAI failed: ${String(err)}`);
      }
    }

    return '';
  }

  private algoFallback(
    incident: { severity: number; affectedCount: number; title: string },
    assignments: { resource: string; type: string; etaMinutes: number }[],
    ragHits: { chunkId: string; title?: string }[],
  ) {
    const lines = [
      '## Decision summary',
      `Algorithmic min-response-time dispatch for "${incident.title}" (severity ${incident.severity}, affected ${incident.affectedCount}).`,
      '',
      '## Why these resources',
      ...assignments.map(
        (a) =>
          `- ${a.resource} (${a.type}): ETA ~${Number(a.etaMinutes).toFixed(1)} min (optimizer cost / spatial+Dijkstra/Maps).`,
      ),
      '',
      '## Protocol alignment',
      ragHits.length
        ? ragHits
            .map((h) => `- Retrieved SOP [${h.title || 'doc'}] [chunk:${h.chunkId}]`)
            .join('\n')
        : '- No strong SOP hit — algorithmic cost dominated.',
      '',
      '## Confidence',
      '- Medium (LLM unavailable; optimizer facts retained).',
    ];
    return lines.join('\n');
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
