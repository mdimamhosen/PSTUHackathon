import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import Redis from 'ioredis';
import { CircuitBreaker } from '../../common/utils/circuit-breaker';
import { haversineEtaMinutes } from '../../common/utils/geo';

@Injectable()
export class MapsService implements OnModuleDestroy {
  private readonly logger = new Logger(MapsService.name);
  private readonly redis: Redis;
  private readonly breaker = new CircuitBreaker(3, 30_000);
  private readonly inflight = new Map<string, Promise<number>>();
  private readonly l1 = new Map<string, { eta: number; exp: number }>();

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis(
      this.config.get<string>('redisUrl') || 'redis://localhost:6379',
      {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      },
    );
    this.redis.connect().catch(() => {
      this.logger.warn(
        'Redis unavailable for Maps cache; using L1/memory only',
      );
    });
  }

  circuitStatus() {
    return this.breaker.getStatus();
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      // ignore
    }
  }

  async etaMinutes(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<{ minutes: number; source: 'google' | 'haversine' | 'cache' }> {
    const key = `eta:${fromLat.toFixed(4)},${fromLng.toFixed(4)}:${toLat.toFixed(4)},${toLng.toFixed(4)}`;
    const l1hit = this.l1.get(key);
    if (l1hit && l1hit.exp > Date.now()) {
      return { minutes: l1hit.eta, source: 'cache' };
    }

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        const minutes = parseFloat(cached);
        this.l1.set(key, { eta: minutes, exp: Date.now() + 15_000 });
        return { minutes, source: 'cache' };
      }
    } catch {
      // ignore redis
    }

    if (this.inflight.has(key)) {
      const minutes = await this.inflight.get(key)!;
      return { minutes, source: 'cache' };
    }

    const promise = this.fetchEta(fromLat, fromLng, toLat, toLng, key);
    this.inflight.set(key, promise);
    try {
      const minutes = await promise;
      const apiKey = this.config.get<string>('googleMapsApiKey');
      return {
        minutes,
        source: apiKey ? 'google' : 'haversine',
      };
    } finally {
      this.inflight.delete(key);
    }
  }

  async invalidateRegionApprox() {
    try {
      const keys = await this.redis.keys('eta:*');
      if (keys.length) await this.redis.del(...keys);
    } catch {
      // ignore
    }
    this.l1.clear();
  }

  private async fetchEta(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    key: string,
  ): Promise<number> {
    const apiKey = this.config.get<string>('googleMapsApiKey');
    const fallback = () => haversineEtaMinutes(fromLat, fromLng, toLat, toLng);

    const minutes = await this.breaker.exec(async () => {
      if (!apiKey) throw new Error('Maps not configured');
      const url = 'https://maps.googleapis.com/maps/api/distancematrix/json';
      const { data } = await axios.get(url, {
        timeout: 4000,
        params: {
          origins: `${fromLat},${fromLng}`,
          destinations: `${toLat},${toLng}`,
          key: apiKey,
          mode: 'driving',
        },
      });
      const element = data?.rows?.[0]?.elements?.[0];
      if (element?.status !== 'OK' || !element.duration?.value) {
        throw new Error('Maps element not OK');
      }
      return Math.max(1, element.duration.value / 60);
    }, fallback);

    this.l1.set(key, { eta: minutes, exp: Date.now() + 15_000 });
    try {
      await this.redis.set(key, String(minutes), 'EX', 45);
    } catch {
      // ignore
    }
    return minutes;
  }
}
