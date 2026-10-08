import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError } from './http/errors.js';
import { loadAuth } from './auth/session.js';
import { authRoutes } from './auth/routes.js';
import { safeEqual } from './util/crypto.js';
import { registerApi } from './api/index.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          // Never log cookies, authorisation headers or CSRF tokens.
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
        }
      : false,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
    maxParamLength: 600, // signed download tokens travel in the path
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", ...config.providers.map((p) => new URL(p.issuer).origin)],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = await loadAuth(req);
  });

  // CSRF: state-changing API calls must carry the session's CSRF token and, if the browser
  // sends an Origin header, it must be our own origin.
  app.addHook('preHandler', async (req) => {
    const guarded = req.url.startsWith('/api/') || req.url.startsWith('/auth/logout');
    if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.APP_BASE_URL).origin) throw new ApiError(403, 'bad_origin');
    if (!req.auth) throw new ApiError(401, 'unauthenticated');
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, req.auth.session.csrf_token)) throw new ApiError(403, 'csrf_failed');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, ...(err.details ? { details: err.details } : {}) });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_failed', details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) } });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate_limited' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'invalid_request' });
    req.log.error({ err }, 'unhandled error');
    if (config.NODE_ENV === 'test') console.error('[500]', req.method, req.url, err);
    return reply.code(500).send({ error: 'internal_error' });
  });

  await app.register(authRoutes);
  await app.register(registerApi, { prefix: '/api' });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
