import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { KafkaService } from './kafka.service';
import { KafkaTopics, KafkaTopicName } from './kafka.topics';

class KafkaPublishDto {
  @ApiProperty({ example: 'emergency.incidents.ingress' })
  @IsString()
  topic!: string;

  @ApiProperty({ type: Object })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  regionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

@ApiTags('kafka')
@ApiHeader({ name: 'x-api-key', required: false })
@Controller('kafka')
export class KafkaController {
  constructor(private readonly kafka: KafkaService) {}

  @Public()
  @Get('status')
  status() {
    return this.kafka.status();
  }

  @Public()
  @Get('topics')
  topics() {
    return { topics: Object.values(KafkaTopics) };
  }

  /**
   * Judge/demo helper: publish into any known topic (e.g. incidents.ingress).
   * Production region gateways should use native Kafka producers.
   */
  @Post('publish')
  async publish(@Body() dto: KafkaPublishDto) {
    const known = Object.values(KafkaTopics) as string[];
    if (!known.includes(dto.topic)) {
      return {
        ok: false,
        error: `Unknown topic. Use one of: ${known.join(', ')}`,
      };
    }
    const ok = await this.kafka.publish(
      dto.topic as KafkaTopicName,
      dto.payload,
      {
        key: dto.key,
        regionId: dto.regionId,
        idempotencyKey: dto.idempotencyKey,
        source: 'http-kafka-bridge',
        eventType: dto.topic,
      },
    );
    return { ok, topic: dto.topic, enabled: this.kafka.isEnabled };
  }
}
