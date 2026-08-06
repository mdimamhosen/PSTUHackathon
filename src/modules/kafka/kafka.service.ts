import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Admin, Consumer, EachMessagePayload, Kafka, Producer, logLevel } from 'kafkajs';
import { randomUUID } from 'crypto';
import {
  ALL_KAFKA_TOPICS,
  KafkaEnvelope,
  KafkaTopics,
  KafkaTopicName,
} from './kafka.topics';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private admin: Admin | null = null;
  private consumers: Consumer[] = [];
  private ready = false;
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  get isEnabled() {
    return this.enabled;
  }

  get isReady() {
    return this.ready;
  }

  status() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      brokers: this.config.get<string>('kafka.brokers') || '',
      clientId: this.config.get<string>('kafka.clientId'),
      topics: ALL_KAFKA_TOPICS,
    };
  }

  async onModuleInit() {
    const brokersRaw = this.config.get<string>('kafka.brokers') || '';
    const flag = this.config.get<boolean>('kafka.enabled');
    this.enabled = flag !== false && brokersRaw.trim().length > 0;
    if (!this.enabled) {
      this.logger.warn('Kafka disabled (set KAFKA_BROKERS / KAFKA_ENABLED=true)');
      return;
    }

    const brokers = brokersRaw.split(',').map((b) => b.trim()).filter(Boolean);
    this.kafka = new Kafka({
      clientId: this.config.get<string>('kafka.clientId') || 'emergency-platform',
      brokers,
      connectionTimeout: 8_000,
      requestTimeout: 25_000,
      logLevel: logLevel.ERROR,
      retry: { retries: 8, initialRetryTime: 300 },
    });

    this.admin = this.kafka.admin();
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
    });

    try {
      await this.admin.connect();
      await this.ensureTopics();
      await this.producer.connect();
      this.ready = true;
      this.logger.log(`Kafka ready @ ${brokers.join(',')}`);
    } catch (err) {
      this.ready = false;
      this.logger.error(`Kafka init failed (fail-soft): ${String(err)}`);
    }
  }

  async onModuleDestroy() {
    for (const c of this.consumers) {
      try {
        await c.disconnect();
      } catch {
        // ignore
      }
    }
    try {
      await this.producer?.disconnect();
    } catch {
      // ignore
    }
    try {
      await this.admin?.disconnect();
    } catch {
      // ignore
    }
  }

  async ensureTopics() {
    if (!this.admin) return;
    const existing = await this.admin.listTopics();
    const missing = ALL_KAFKA_TOPICS.filter((t) => !existing.includes(t));
    if (!missing.length) return;

    const partitions = this.config.get<number>('kafka.partitions') || 6;
    const replication = this.config.get<number>('kafka.replicationFactor') || 1;
    await this.admin.createTopics({
      waitForLeaders: true,
      topics: missing.map((topic) => ({
        topic,
        numPartitions: partitions,
        replicationFactor: replication,
        configEntries: [
          { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
          { name: 'cleanup.policy', value: 'delete' },
        ],
      })),
    });
    this.logger.log(`Created Kafka topics: ${missing.join(', ')}`);
  }

  /**
   * Fire-and-forget publish — never throws to callers (hot path safe).
   */
  async publish<T extends Record<string, unknown>>(
    topic: KafkaTopicName,
    payload: T,
    opts?: {
      key?: string;
      eventType?: string;
      source?: string;
      regionId?: string;
      idempotencyKey?: string;
      correlationId?: string;
      headers?: Record<string, string>;
    },
  ): Promise<boolean> {
    if (!this.enabled || !this.ready || !this.producer) return false;
    const envelope: KafkaEnvelope<T> = {
      eventId: randomUUID(),
      eventType: opts?.eventType || topic,
      occurredAt: new Date().toISOString(),
      source: opts?.source || 'emergency-platform',
      regionId: opts?.regionId,
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      payload,
    };
    try {
      await this.producer.send({
        topic,
        messages: [
          {
            key: opts?.key || opts?.regionId || envelope.eventId,
            value: JSON.stringify(envelope),
            headers: {
              eventType: envelope.eventType,
              source: envelope.source,
              ...(opts?.headers || {}),
            },
          },
        ],
      });
      return true;
    } catch (err) {
      this.logger.warn(`Kafka publish failed ${topic}: ${String(err)}`);
      try {
        await this.producer.send({
          topic: KafkaTopics.DLQ,
          messages: [
            {
              key: opts?.key || envelope.eventId,
              value: JSON.stringify({
                failedTopic: topic,
                error: String(err),
                envelope,
              }),
            },
          ],
        });
      } catch {
        // ignore secondary DLQ failure
      }
      return false;
    }
  }

  async subscribe(
    groupId: string,
    topics: KafkaTopicName[],
    handler: (msg: {
      topic: string;
      key: string | null;
      envelope: KafkaEnvelope;
      raw: EachMessagePayload;
    }) => Promise<void>,
  ) {
    if (!this.enabled || !this.kafka) {
      this.logger.warn(`Skip consumer ${groupId} — Kafka disabled`);
      return;
    }
    if (!this.ready) {
      // retry briefly
      for (let i = 0; i < 10 && !this.ready; i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!this.ready) {
      this.logger.error(`Consumer ${groupId} not started — Kafka not ready`);
      return;
    }

    const consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      maxWaitTimeInMs: 3_000,
      retry: { retries: 8 },
    });
    this.consumers.push(consumer);
    await consumer.connect();
    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
      autoCommit: true,
      partitionsConsumedConcurrently: Math.min(topics.length, 3),
      eachMessage: async (raw) => {
        const value = raw.message.value?.toString('utf8');
        if (!value) return;
        let envelope: KafkaEnvelope;
        try {
          envelope = JSON.parse(value) as KafkaEnvelope;
        } catch {
          await this.publish(
            KafkaTopics.DLQ,
            {
              reason: 'invalid_json',
              topic: raw.topic,
              value,
            },
            { key: raw.message.key?.toString() || undefined },
          );
          return;
        }
        try {
          await handler({
            topic: raw.topic,
            key: raw.message.key?.toString() || null,
            envelope,
            raw,
          });
        } catch (err) {
          this.logger.error(
            `Handler error ${raw.topic}: ${String(err)}`,
          );
          await this.publish(
            KafkaTopics.DLQ,
            {
              reason: 'handler_error',
              topic: raw.topic,
              error: String(err),
              envelope,
            },
            {
              key: envelope.idempotencyKey || envelope.eventId,
              regionId: envelope.regionId,
            },
          );
        }
      },
    });
    this.logger.log(
      `Kafka consumer ${groupId} listening: ${topics.join(', ')}`,
    );
  }
}
