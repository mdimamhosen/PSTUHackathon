import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly config: ConfigService) {}

  async afterInit() {
    try {
      const url =
        this.config.get<string>('redisUrl') || 'redis://localhost:6379';
      const pub = createClient({ url });
      const sub = pub.duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      this.server.adapter(createAdapter(pub, sub) as never);
      this.logger.log('Socket.IO Redis adapter enabled');
    } catch (err) {
      this.logger.warn(`Redis adapter disabled: ${String(err)}`);
    }
  }

  @SubscribeMessage('join')
  handleJoin(client: Socket, @MessageBody() room: string) {
    if (typeof room === 'string' && room.length < 120) {
      client.join(room);
      return { joined: room };
    }
    return { error: 'invalid room' };
  }

  emitAssignment(regionId: string, incidentId: string, payload: unknown) {
    this.server?.to(`region:${regionId}`).emit('assignment', payload);
    this.server?.to(`incident:${incidentId}`).emit('assignment', payload);
  }

  emitAgentStep(incidentId: string, payload: unknown) {
    this.server?.to(`agent:${incidentId}`).emit('agent.step', payload);
    this.server?.to(`incident:${incidentId}`).emit('agent.step', payload);
  }

  emitEvent(regionId: string, payload: unknown) {
    this.server?.to(`region:${regionId}`).emit('environment', payload);
  }
}
