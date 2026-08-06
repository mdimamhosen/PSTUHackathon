const configuration = () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  apiKey: process.env.API_KEY || 'change-me-demo-api-key',
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramEocChatId: process.env.TELEGRAM_EOC_CHAT_ID || '',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'noreply@emergency.local',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },
  agentTimeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '20000', 10),
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  maxQueueDepth: parseInt(process.env.MAX_QUEUE_DEPTH || '5000', 10),
  workerMode: process.env.WORKER_MODE === 'true',
  kafka: {
    enabled:
      process.env.KAFKA_ENABLED === 'true' ||
      !!(process.env.KAFKA_BROKERS && process.env.KAFKA_BROKERS.trim()),
    brokers: process.env.KAFKA_BROKERS || '',
    clientId: process.env.KAFKA_CLIENT_ID || 'emergency-platform',
    partitions: parseInt(process.env.KAFKA_PARTITIONS || '6', 10),
    replicationFactor: parseInt(process.env.KAFKA_REPLICATION_FACTOR || '1', 10),
  },
});

export type AppConfig = ReturnType<typeof configuration>;
export default configuration;
