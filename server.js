import './src/core/env.js';
import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';

import { runSchema } from './src/db/connection.js';
import sprintsRouter from './src/api/sprints.js';
import statusRouter from './src/api/status.js';
import webhookRouter from './src/api/webhook.js';
import tasksRouter from './src/api/tasks.js';
import { setupWebhook } from './src/services/telegram.js';

const app = express();
app.use(cors());
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serve web portal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/portal/index.html'));
});

// Register API routes
app.use('/api/sprints', sprintsRouter);
app.use('/api/status', statusRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/tasks', tasksRouter);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Application Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Run DB table initialization
await runSchema();

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Supervisor online and listening on port ${PORT}`);
  
  // If a Telegram Webhook URL is specified in .env, register it
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  if (webhookUrl && !webhookUrl.startsWith('your_')) {
    try {
      await setupWebhook(webhookUrl);
    } catch (error) {
      console.error('Failed to configure Telegram Webhook on startup:', error);
    }
  }
});
