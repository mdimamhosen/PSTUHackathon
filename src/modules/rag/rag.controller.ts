import { Body, Controller, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { RagService } from './rag.service';

class RagQueryDto {
  @IsString()
  query!: string;
}

class RagIngestDto {
  @IsString()
  title!: string;
  @IsString()
  source!: string;
  @IsString()
  content!: string;
  @IsOptional()
  @IsString()
  disasterType?: string;
  @IsOptional()
  @IsString()
  regionScope?: string;
}

@ApiTags('rag')
@ApiHeader({ name: 'x-api-key', required: false })
@Controller('rag')
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Post('query')
  async query(@Body() dto: RagQueryDto) {
    // Grounded answer with strong RAG system prompt + hybrid retrieval
    return this.rag.answerQuery(dto.query);
  }

  @Post('ingest')
  async ingest(@Body() dto: RagIngestDto) {
    const doc = await this.rag.ingestDocument(dto);
    return { id: doc.id, title: doc.title };
  }
}
