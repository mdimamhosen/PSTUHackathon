/**
 * Kafka topic catalog — real-time national emergency bus.
 * Ingress (*.ingress) = region gateways → platform
 * Domain (*.events)   = platform fan-out after durable persist
 * DLQ                 = poison / failed processing
 */
export const KafkaTopics = {
  /** Region gateways publish raw incident creates */
  INCIDENTS_INGRESS: 'emergency.incidents.ingress',
  /** After DB + BullMQ dispatch enqueue */
  INCIDENTS_CREATED: 'emergency.incidents.created',
  INCIDENTS_UPDATED: 'emergency.incidents.updated',

  RESOURCES_INGRESS: 'emergency.resources.ingress',
  RESOURCES_UPDATED: 'emergency.resources.updated',
  RESOURCES_FAILED: 'emergency.resources.failed',

  ENVIRONMENT_INGRESS: 'emergency.environment.ingress',
  ENVIRONMENT_RECORDED: 'emergency.environment.recorded',

  DISPATCHES_ASSIGNED: 'emergency.dispatches.assigned',
  REGION_REOPT_TRIGGERED: 'emergency.region.reopt.triggered',

  DLQ: 'emergency.dlq',
} as const;

export type KafkaTopicName = (typeof KafkaTopics)[keyof typeof KafkaTopics];

export const ALL_KAFKA_TOPICS: KafkaTopicName[] = Object.values(KafkaTopics);

export const KafkaConsumerGroups = {
  INGRESS: 'emergency-ingress-workers',
  AUDIT: 'emergency-audit-mirrors',
} as const;

export type KafkaEnvelope<T = Record<string, unknown>> = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  source: string;
  regionId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  payload: T;
};
