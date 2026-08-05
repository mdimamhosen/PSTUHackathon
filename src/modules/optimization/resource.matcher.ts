import { Injectable, Logger } from '@nestjs/common';
import {
  AssignmentStatus,
  Incident,
  Prisma,
  Resource,
  ResourceStatus,
  ResourceType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { SpatialGrid } from './algorithms/spatial-grid';
import { hungarianMinCost } from './algorithms/hungarian';
import { MinHeap } from './algorithms/binary-heap';
import { RoutingService } from './routing.service';

export type CandidateScore = {
  resource: Resource;
  score: number;
  cost: number;
  etaMinutes: number;
  etaSource: string;
  breakdown: Record<string, number | string>;
  algorithm: string;
};

const TYPE_NEEDS: Record<string, ResourceType[]> = {
  medical: [ResourceType.AMBULANCE, ResourceType.HOSPITAL],
  rescue: [ResourceType.RESCUE_TEAM, ResourceType.HELICOPTER],
  fire: [ResourceType.RESCUE_TEAM, ResourceType.HELICOPTER],
  flood: [ResourceType.RESCUE_TEAM, ResourceType.HELICOPTER, ResourceType.AMBULANCE],
  cyclone: [ResourceType.AMBULANCE, ResourceType.RESCUE_TEAM, ResourceType.HELICOPTER],
  default: [
    ResourceType.AMBULANCE,
    ResourceType.RESCUE_TEAM,
    ResourceType.HOSPITAL,
    ResourceType.HELICOPTER,
  ],
};

@Injectable()
export class ResourceMatcher {
  private readonly logger = new Logger(ResourceMatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
    private readonly metrics: MetricsService,
  ) {}

  neededTypes(incident: Incident): ResourceType[] {
    const needs = incident.resourceNeeds as Record<string, unknown>;
    const types = new Set<ResourceType>();
    if (Array.isArray(needs?.types)) {
      for (const t of needs.types as string[]) {
        if (t in ResourceType) types.add(t as ResourceType);
      }
    }
    const disaster = (incident.disasterType || 'default').toLowerCase();
    for (const t of TYPE_NEEDS[disaster] || TYPE_NEEDS.default) types.add(t);
    if (!types.size) {
      for (const t of TYPE_NEEDS.default) types.add(t);
    }
    return [...types];
  }

  /**
   * Scalable candidate pipeline:
   * 1) Spatial grid prune (avoid O(N) scan)
   * 2) Min travel-time via Maps / Dijkstra shortest-time
   * 3) Cost = ETA + penalties (objective: minimize response time)
   */
  async findCandidates(incident: Incident, limit = 12): Promise<CandidateScore[]> {
    const types = this.neededTypes(incident);
    const blockedRoads = await this.prisma.environmentEvent.findMany({
      where: {
        regionId: incident.regionId,
        active: true,
        type: { in: ['ROAD_BLOCKED', 'WEATHER_HAZARD'] },
      },
    });

    const resources = await this.prisma.resource.findMany({
      where: {
        regionId: incident.regionId,
        status: ResourceStatus.AVAILABLE,
        remainingCapacity: { gt: 0 },
        type: { in: types },
      },
      take: 200,
    });

    const grid = new SpatialGrid<Resource>(0.05);
    for (const r of resources) {
      if (!this.isBlocked(r, blockedRoads)) grid.insert(r);
    }

    let nearby = grid.queryNear(incident.lat, incident.lng, 3);
    if (nearby.length < 6) {
      nearby = resources.filter((r) => !this.isBlocked(r, blockedRoads));
    }

    // Bound work: keep k nearest by straight-line before expensive ETA
    nearby.sort(
      (a, b) =>
        this.routing.straightLineKm(a.lat, a.lng, incident.lat, incident.lng) -
        this.routing.straightLineKm(b.lat, b.lng, incident.lat, incident.lng),
    );
    nearby = nearby.slice(0, 24);

    const scored: CandidateScore[] = [];
    for (const resource of nearby) {
      const travel = await this.routing.minTravelTime(
        incident.regionId,
        resource.lat,
        resource.lng,
        incident.lat,
        incident.lng,
      );
      const capacityFit =
        resource.remainingCapacity / Math.max(1, resource.capacity);
      const typeMatch = types.includes(resource.type) ? 1 : 0.3;
      const constraintPenalty = this.constraintPenalty(resource, incident);
      const failureRisk =
        resource.status === ResourceStatus.MAINTENANCE ? 1 : 0.05;

      const cost = this.routing.assignmentCost(travel.minutes, {
        typeMismatch: 1 - typeMatch,
        constraintPenalty,
        severityBoost: incident.severity,
      });

      // Higher score = better for display; inverse of cost
      const score =
        1000 / Math.max(cost, 0.5) +
        capacityFit * 10 +
        typeMatch * 15 -
        failureRisk * 8;

      scored.push({
        resource,
        score,
        cost,
        etaMinutes: travel.minutes,
        etaSource: travel.source,
        algorithm: `spatial-grid+min-time(${travel.source})`,
        breakdown: {
          cost,
          etaMinutes: travel.minutes,
          etaSource: travel.source,
          capacityFit,
          typeMatch,
          constraintPenalty,
          failureRisk,
          pathNodes: travel.pathNodes ?? 0,
          nodesExpanded: travel.nodesExpanded ?? 0,
          objective: 'minimize_total_response_time',
        },
      });
    }

    // Min-cost first (response time), then score
    scored.sort((a, b) => a.cost - b.cost || b.score - a.score);
    return scored.slice(0, limit);
  }

  async assignForIncident(
    incidentId: string,
    trigger = 'dispatch',
  ): Promise<{ assignments: string[]; latencyMs: number; algorithm: string }> {
    const started = Date.now();
    const incident = await this.prisma.incident.findUniqueOrThrow({
      where: { id: incidentId },
    });

    const existing = await this.prisma.dispatchAssignment.findMany({
      where: {
        incidentId,
        status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE', 'PROPOSED'] },
      },
    });
    if (existing.length > 0 && trigger === 'dispatch') {
      return {
        assignments: existing.map((e) => e.id),
        latencyMs: Date.now() - started,
        algorithm: 'idempotent-hit',
      };
    }

    const candidates = await this.findCandidates(incident);
    const needsCount = Math.min(
      3,
      Math.max(1, Math.ceil(incident.affectedCount / 20)),
    );

    // Diversify types while minimizing cost (best-first by cost with type coverage)
    const chosen = this.pickMinCostDiverse(candidates, needsCount);
    const assignmentIds = await this.commitAssignments(incident, chosen);

    const latencyMs = Date.now() - started;
    const algorithm =
      'spatial_grid + dijkstra_or_maps_min_time + greedy_min_cost_diverse';
    await this.prisma.optimizationRun.create({
      data: {
        incidentId: incident.id,
        regionId: incident.regionId,
        inputSnapshot: {
          severity: incident.severity,
          affectedCount: incident.affectedCount,
          lat: incident.lat,
          lng: incident.lng,
          algorithm,
          objective: 'minimize_response_time',
        },
        selectedIds: assignmentIds,
        scores: chosen.map((c) => ({
          resourceId: c.resource.id,
          score: c.score,
          cost: c.cost,
          eta: c.etaMinutes,
          source: c.etaSource,
        })),
        latencyMs,
        explanation: chosen
          .map(
            (c) =>
              `${c.resource.name}: cost=${c.cost.toFixed(1)} eta=${c.etaMinutes.toFixed(1)}m via ${c.etaSource}`,
          )
          .join('; '),
        trigger,
      },
    });
    await this.metrics.observe('assign.latencyMs', latencyMs);
    await this.metrics.incr('assign.total');
    await this.metrics.incr(`routing.${chosen[0]?.etaSource || 'none'}`);
    return { assignments: assignmentIds, latencyMs, algorithm };
  }

  /**
   * Region reopt: Hungarian min-cost bipartite matching over pending incidents
   * × available resources — globally minimizes Σ travel time (scalable O(n³) for n≤50).
   */
  async reoptimizeRegion(regionId: string) {
    await this.metrics.incr('reopt.total');
    this.routing.invalidateRegion(regionId);

    const broken = await this.prisma.dispatchAssignment.findMany({
      where: {
        incident: { regionId },
        status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE'] },
        resource: { status: { in: ['FAILED', 'MAINTENANCE'] } },
      },
    });
    for (const a of broken) {
      await this.prisma.dispatchAssignment.update({
        where: { id: a.id },
        data: { status: 'RELEASED' },
      });
      await this.prisma.incident.update({
        where: { id: a.incidentId },
        data: { status: 'PENDING' },
      });
    }

    // Urgency heap: process high priorityScore first when building demand slots
    const pending = await this.prisma.incident.findMany({
      where: {
        regionId,
        status: { in: ['PENDING', 'ASSIGNED'] },
      },
      take: 40,
    });

    const urgency = new MinHeap<Incident>(
      (a, b) => b.priorityScore - a.priorityScore < 0,
    );
    // Max-heap via inverted compare: higher priorityScore first
    const ordered = [...pending].sort(
      (a, b) => b.priorityScore - a.priorityScore || b.severity - a.severity,
    );
    for (const i of ordered) urgency.push(i);

    const needsSlots: { incident: Incident; slot: number }[] = [];
    while (urgency.size) {
      const incident = urgency.pop()!;
      const active = await this.prisma.dispatchAssignment.count({
        where: {
          incidentId: incident.id,
          status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE'] },
        },
      });
      if (active > 0 && incident.severity < 4) continue;
      const need = Math.min(
        2,
        Math.max(active === 0 ? 1 : 0, Math.ceil(incident.affectedCount / 30)),
      );
      for (let s = 0; s < need; s++) {
        needsSlots.push({ incident, slot: s });
      }
    }

    const resources = await this.prisma.resource.findMany({
      where: {
        regionId,
        status: ResourceStatus.AVAILABLE,
        remainingCapacity: { gt: 0 },
      },
      take: 80,
    });

    if (!needsSlots.length || !resources.length) {
      // Fallback sequential for empty matching set
      for (const incident of ordered) {
        const active = await this.prisma.dispatchAssignment.count({
          where: {
            incidentId: incident.id,
            status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE'] },
          },
        });
        if (active === 0) await this.assignForIncident(incident.id, 'reopt');
      }
      return {
        processed: pending.length,
        released: broken.length,
        algorithm: 'fallback_sequential_min_cost',
        hungarianTotalCost: 0,
      };
    }

    // Cost matrix: rows = demand slots, cols = resources
    const BIG = 1e6;
    const cost: number[][] = [];
    for (const slot of needsSlots) {
      const row: number[] = [];
      const types = this.neededTypes(slot.incident);
      for (const resource of resources) {
        if (!types.includes(resource.type)) {
          row.push(BIG);
          continue;
        }
        const travel = await this.routing.minTravelTime(
          regionId,
          resource.lat,
          resource.lng,
          slot.incident.lat,
          slot.incident.lng,
        );
        row.push(
          this.routing.assignmentCost(travel.minutes, {
            typeMismatch: 0,
            constraintPenalty: this.constraintPenalty(resource, slot.incident),
            severityBoost: slot.incident.severity,
          }),
        );
      }
      cost.push(row);
    }

    const { assignment, totalCost } = hungarianMinCost(cost);
    await this.metrics.observe('hungarian.totalCost', totalCost);
    await this.metrics.incr('hungarian.runs');

    // Commit matching (one resource used at most once in this batch)
    const usedResources = new Set<string>();
    let matched = 0;
    for (let i = 0; i < assignment.length; i++) {
      const col = assignment[i];
      if (col < 0 || cost[i][col] >= BIG / 2) continue;
      const resource = resources[col];
      if (usedResources.has(resource.id)) continue;
      usedResources.add(resource.id);
      const incident = needsSlots[i].incident;
      const travel = await this.routing.minTravelTime(
        regionId,
        resource.lat,
        resource.lng,
        incident.lat,
        incident.lng,
      );
      const candidate: CandidateScore = {
        resource,
        score: 1000 / Math.max(travel.minutes, 0.5),
        cost: cost[i][col],
        etaMinutes: travel.minutes,
        etaSource: travel.source,
        algorithm: 'hungarian_min_cost',
        breakdown: {
          cost: cost[i][col],
          etaMinutes: travel.minutes,
          etaSource: travel.source,
          objective: 'minimize_sum_eta_hungarian',
        },
      };
      await this.commitAssignments(incident, [candidate]);
      matched++;
    }

    // Anything still uncovered
    for (const incident of ordered) {
      const active = await this.prisma.dispatchAssignment.count({
        where: {
          incidentId: incident.id,
          status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE'] },
        },
      });
      if (active === 0) await this.assignForIncident(incident.id, 'reopt-fill');
    }

    return {
      processed: pending.length,
      released: broken.length,
      matched,
      hungarianTotalCost: totalCost,
      algorithm: 'hungarian_min_cost_bipartite + dijkstra/maps_eta',
    };
  }

  private pickMinCostDiverse(
    candidates: CandidateScore[],
    need: number,
  ): CandidateScore[] {
    const chosen: CandidateScore[] = [];
    const usedTypes = new Set<ResourceType>();
    const usedIds = new Set<string>();

    // Pass 1: cheapest per uncovered type
    for (const c of candidates) {
      if (chosen.length >= need) break;
      if (usedIds.has(c.resource.id)) continue;
      if (usedTypes.has(c.resource.type) && chosen.length > 0) continue;
      chosen.push(c);
      usedIds.add(c.resource.id);
      usedTypes.add(c.resource.type);
    }
    // Pass 2: fill remaining by pure min cost
    for (const c of candidates) {
      if (chosen.length >= need) break;
      if (usedIds.has(c.resource.id)) continue;
      chosen.push(c);
      usedIds.add(c.resource.id);
    }
    return chosen;
  }

  private async commitAssignments(
    incident: Incident,
    chosen: CandidateScore[],
  ): Promise<string[]> {
    const assignmentIds: string[] = [];
    for (const c of chosen) {
      try {
        const id = await this.prisma.$transaction(async (tx) => {
          const fresh = await tx.resource.findUnique({
            where: { id: c.resource.id },
          });
          if (
            !fresh ||
            fresh.status !== ResourceStatus.AVAILABLE ||
            fresh.remainingCapacity <= 0
          ) {
            await this.metrics.incr('assign.conflictRetries');
            return null;
          }
          const updated = await tx.resource.updateMany({
            where: {
              id: fresh.id,
              version: fresh.version,
              status: ResourceStatus.AVAILABLE,
              remainingCapacity: { gt: 0 },
            },
            data: {
              remainingCapacity: { decrement: 1 },
              status:
                fresh.remainingCapacity - 1 <= 0
                  ? ResourceStatus.RESERVED
                  : ResourceStatus.AVAILABLE,
              version: { increment: 1 },
            },
          });
          if (updated.count === 0) {
            await this.metrics.incr('assign.conflictRetries');
            return null;
          }
          const assignment = await tx.dispatchAssignment.upsert({
            where: {
              incidentId_resourceId_role: {
                incidentId: incident.id,
                resourceId: fresh.id,
                role: fresh.type,
              },
            },
            create: {
              incidentId: incident.id,
              resourceId: fresh.id,
              role: fresh.type,
              etaMinutes: c.etaMinutes,
              score: c.score,
              scoreBreakdown: c.breakdown as Prisma.InputJsonValue,
              explanation: this.algoExplanation(incident, c),
              status: AssignmentStatus.ASSIGNED,
            },
            update: {
              etaMinutes: c.etaMinutes,
              score: c.score,
              scoreBreakdown: c.breakdown as Prisma.InputJsonValue,
              status: AssignmentStatus.ASSIGNED,
              explanation: this.algoExplanation(incident, c),
            },
          });
          await tx.incident.update({
            where: { id: incident.id },
            data: { status: 'ASSIGNED' },
          });
          return assignment.id;
        });
        if (id) assignmentIds.push(id);
      } catch (err) {
        this.logger.warn(`Assign failed for ${c.resource.id}: ${String(err)}`);
      }
    }
    return assignmentIds;
  }

  private isBlocked(
    resource: Resource,
    events: { type: string; payload: Prisma.JsonValue }[],
  ): boolean {
    for (const e of events) {
      const p = e.payload as { lat?: number; lng?: number; radiusKm?: number };
      if (p.lat == null || p.lng == null) continue;
      const d = this.routing.straightLineKm(
        resource.lat,
        resource.lng,
        p.lat,
        p.lng,
      );
      if (d < (p.radiusKm ?? 2)) return true;
    }
    return false;
  }

  private constraintPenalty(resource: Resource, incident: Incident): number {
    const c = (resource.constraints || {}) as Record<string, unknown>;
    let penalty = 0;
    if (c.noNight && new Date().getHours() > 20) penalty += 0.5;
    if (c.maxSeverity && incident.severity > Number(c.maxSeverity))
      penalty += 0.8;
    if (resource.type === ResourceType.HELICOPTER) {
      const env = (incident.environment || {}) as Record<string, unknown>;
      if (env.weather === 'storm') penalty += 0.9;
    }
    return penalty;
  }

  private algoExplanation(incident: Incident, c: CandidateScore): string {
    return [
      `[${c.algorithm}] Assigned ${c.resource.name} (${c.resource.type}) to severity-${incident.severity} incident.`,
      `Min travel time ~${c.etaMinutes.toFixed(1)} min via ${c.etaSource} (cost=${c.cost.toFixed(1)}).`,
      `Objective: minimize response time with spatial prune + shortest-time routing.`,
    ].join(' ');
  }
}
