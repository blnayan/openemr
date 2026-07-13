/**
 * GET /conversation/:id — return persisted message history for the
 * authenticated user, scoped to the patient bound by the JWT.
 */

import type { FastifyInstance } from 'fastify';
import type { ConversationRepository } from '../db/ConversationRepository.js';

export interface ConversationRouteOptions {
  repository: ConversationRepository;
}

export function registerConversationRoute(app: FastifyInstance, opts: ConversationRouteOptions): void {
  app.get<{ Params: { id: string } }>('/conversation/:id', async (request, reply) => {
    const { id } = request.params;
    // Bind to (userId, pid) from the JWT — both are signed by the OpenEMR
    // session boundary. A leaked cid for patient X cannot be replayed
    // while patient Y is in the JWT's pid claim.
    const messages = await opts.repository.load(
      id,
      request.jwtClaims.sub,
      request.jwtClaims.pid,
    );
    reply.code(200).send({ conversation_id: id, messages });
  });
}
