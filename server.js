import './src/core/env.js';
import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { execSync } from 'child_process';

import { pool, runSchema } from './src/db/connection.js';
import { startPoller } from './src/core/poller.js';
import phasesRouter from './src/api/phases.js';
import statusRouter from './src/api/status.js';
import webhookRouter from './src/api/webhook.js';
import tasksRouter from './src/api/tasks.js';
import { setupWebhook } from './src/services/telegram.js';
import { securityBlocker } from './src/api/securityBlocker.js';

const app = express();
app.use(cors());
app.use(express.json());

// Strict Express-level request blocker to prevent sensitive/config file exposure and directory traversal
app.use(securityBlocker);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serve web portal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/portal/index.html'));
});

// Register API routes
app.use('/api/phases', phasesRouter);
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

// Auto-resume active pollers on start
try {
  const [activePhases] = await pool.query("SELECT id FROM phases WHERE status = 'active'");
  for (const phase of activePhases) {
    startPoller(phase.id);
    console.log(`Resumed background supervisor poller for phase #${phase.id}`);
  }
} catch (error) {
  console.error('Failed to resume active pollers on startup:', error);
}

const PORT = process.env.PORT || 3000;
const USE_HTTPS = process.env.USE_HTTPS === 'true';

let server;

if (USE_HTTPS) {
  const keyPath = path.join(__dirname, 'server.key');
  const certPath = path.join(__dirname, 'server.crt');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    try {
      console.log('Generating self-signed SSL certificate for HTTPS server...');
      execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/CN=localhost"`);
    } catch (certErr) {
      console.error('Failed to generate self-signed SSL cert via openssl:', certErr.message);
    }
  }

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    server = https.createServer(options, app);
    console.log('Starting HTTPS server...');
  } else {
    console.warn('SSL key/cert missing, falling back to HTTP server.');
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

server.listen(PORT, async () => {
  console.log(`Supervisor online and listening on port ${PORT} (${USE_HTTPS ? 'HTTPS' : 'HTTP'})`);
  
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

