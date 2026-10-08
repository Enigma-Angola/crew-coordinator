import type { FastifyInstance } from 'fastify';
import { meRoutes } from './me.js';
import { adminRoutes } from './admin.js';
import { personnelRoutes, fileRoutes } from './personnel.js';
import { operationsRoutes } from './operations.js';
import { collaborationRoutes } from './collaboration.js';
import { communicationsRoutes } from './communications.js';
import { dashboardRoutes } from './dashboards.js';
import { exportRoutes } from './exports.js';
import { eventRoutes } from '../realtime/events.js';

export async function registerApi(app: FastifyInstance) {
  // API responses are never cached by browsers or intermediaries.
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
  });
  await app.register(meRoutes);
  await app.register(adminRoutes);
  await app.register(personnelRoutes);
  await app.register(fileRoutes);
  await app.register(operationsRoutes);
  await app.register(collaborationRoutes);
  await app.register(communicationsRoutes);
  await app.register(dashboardRoutes);
  await app.register(exportRoutes);
  await app.register(eventRoutes);
}
