import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp({ logger: true });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
