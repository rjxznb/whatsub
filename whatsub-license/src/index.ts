import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.text('whatsub license server'));

const port = Number(process.env['PORT'] ?? 3000);
serve({ fetch: app.fetch, port });
