import { Module, forwardRef } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { RagModule } from '../rag/rag.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RagModule, forwardRef(() => RealtimeModule)],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
