import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MapsService } from '../maps/maps.service';
import {
  buildRegionMeshGraph,
  dijkstraShortestTime,
  WeightedGraph,
} from './algorithms/dijkstra';
import { haversineEtaMinutes, haversineKm } from '../../common/utils/geo';

export type TravelEstimate = {
  minutes: number;
  source: 'google' | 'dijkstra' | 'haversine' | 'cache';
  pathNodes?: number;
  nodesExpanded?: number;
};

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private graphCache = new Map<
    string,
    {
      graph: WeightedGraph;
      nearestNode: (lat: number, lng: number) => string;
      exp: number;
    }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maps: MapsService,
  ) {}

  /**
   * Minimum travel time: Google Maps when available, else Dijkstra on region mesh
   * (shortest-time path avoiding ROAD_BLOCKED), else Haversine fallback.
   */
  async minTravelTime(
    regionId: string,
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<TravelEstimate> {
    const mapsEta = await this.maps.etaMinutes(fromLat, fromLng, toLat, toLng);
    if (mapsEta.source === 'google' || mapsEta.source === 'cache') {
      // Still verify Dijkstra isn't drastically better around blocks
      const dij = await this.dijkstraEta(regionId, fromLat, fromLng, toLat, toLng);
      if (dij && dij.minutes + 0.5 < mapsEta.minutes) {
        return dij;
      }
      return {
        minutes: mapsEta.minutes,
        source: mapsEta.source === 'cache' ? 'cache' : 'google',
      };
    }

    const dij = await this.dijkstraEta(regionId, fromLat, fromLng, toLat, toLng);
    if (dij) return dij;

    return {
      minutes: haversineEtaMinutes(fromLat, fromLng, toLat, toLng),
      source: 'haversine',
    };
  }

  invalidateRegion(regionId: string) {
    this.graphCache.delete(regionId);
  }

  private async dijkstraEta(
    regionId: string,
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<TravelEstimate | null> {
    try {
      const mesh = await this.getMesh(regionId);
      if (!mesh) return null;
      const src = mesh.nearestNode(fromLat, fromLng);
      const dst = mesh.nearestNode(toLat, toLng);
      const result = dijkstraShortestTime(mesh.graph, src, dst);
      if (!result) return null;
      // Add last-mile haversine from resource/incident to mesh nodes (~small)
      const lastMile =
        haversineEtaMinutes(fromLat, fromLng, toLat, toLng) * 0.05;
      return {
        minutes: Math.max(1, result.minutes + lastMile),
        source: 'dijkstra',
        pathNodes: result.path.length,
        nodesExpanded: result.nodesExpanded,
      };
    } catch (err) {
      this.logger.warn(`Dijkstra failed: ${String(err)}`);
      return null;
    }
  }

  private async getMesh(regionId: string) {
    const cached = this.graphCache.get(regionId);
    if (cached && cached.exp > Date.now()) return cached;

    const region = await this.prisma.region.findUnique({ where: { id: regionId } });
    if (!region) return null;

    const events = await this.prisma.environmentEvent.findMany({
      where: {
        regionId,
        active: true,
        type: { in: ['ROAD_BLOCKED', 'WEATHER_HAZARD'] },
      },
    });
    const blocks = events
      .map((e) => {
        const p = e.payload as { lat?: number; lng?: number; radiusKm?: number };
        if (p.lat == null || p.lng == null) return null;
        return { lat: p.lat, lng: p.lng, radiusKm: p.radiusKm ?? 2 };
      })
      .filter(Boolean) as { lat: number; lng: number; radiusKm: number }[];

    const built = buildRegionMeshGraph({
      minLat: region.minLat,
      maxLat: region.maxLat,
      minLng: region.minLng,
      maxLng: region.maxLng,
      step: 0.035,
      speedKmh: 35,
      blocks,
    });

    const entry = { ...built, exp: Date.now() + 30_000 };
    this.graphCache.set(regionId, entry);
    return entry;
  }

  /** Cost used by Hungarian: travel minutes + soft penalties. */
  assignmentCost(
    etaMinutes: number,
    opts: {
      typeMismatch?: number;
      constraintPenalty?: number;
      severityBoost?: number;
    },
  ): number {
    // Primary objective: minimize response time
    let cost = etaMinutes;
    cost += (opts.typeMismatch ?? 0) * 15;
    cost += (opts.constraintPenalty ?? 0) * 20;
    // Higher severity → slightly prefer faster options (lower effective cost)
    cost *= 1 - Math.min(0.25, (opts.severityBoost ?? 0) * 0.05);
    return cost;
  }

  straightLineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
    return haversineKm(aLat, aLng, bLat, bLng);
  }
}
