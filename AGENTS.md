# Agent Guide — Jules Supervisor

This guide outlines the commands and guidelines for AI coding agents and developers working on the `jules-supervisor` repository.

---

## 🚀 Commands

### Setup & Install
- Install dependencies: `npm install`
- Create environment file: `cp .env.example .env`

### Execution
- Start production server: `npm start`
- Start development server (watch mode): `npm run dev`

### Diagnostics & Smoke Tests
- Test database connection syntax:
  ```bash
  node -e "import('./src/db/connection.js').then(m => m.pool.query('SELECT 1').then(console.log))"
  ```
- Test service wrappers syntax and mock checks:
  ```bash
  node -e "import('./src/services/ai.js'); import('./src/services/telegram.js'); import('./src/services/jules.js');"
  ```
- Test core system modules:
  ```bash
  node -e "import('./src/core/contextBuilder.js'); import('./src/core/taskManager.js'); import('./src/core/questionHandler.js');"
  ```

---

## 🎨 Code Style & Architectural Guidelines

### Modules
- **Module System**: EcmaScript Modules (ESM). All files must use `import` and `export` statements.
- **Imports**: Always include the `.js` file extension in relative imports (e.g. `import { pool } from './connection.js';`).

### Error Handling
- Use `express-async-errors` to automatically route async router errors to the global error handler in `server.js`.
- Always wrap database query blocks in `try-finally` or `try-catch` to ensure database connections are released back to the pool.

### Telegram Wrapper
- The bot supports both Webhooks and Long-Polling.
- If `TELEGRAM_WEBHOOK_URL` is omitted from `.env`, the wrapper defaults to standard polling mode.
- If `TELEGRAM_BOT_TOKEN` is missing, the service falls back to a **Mock Mode** to prevent the application from crashing on startup.

### 🛡️ Safety & Branch Isolation Rules
- **Phase Branch Isolation**: The supervisor operates inside a dedicated `feature/phase-XX` branch created from `main`. Every Jules task must target this branch.
- **Never Merge to Main**: The supervisor must **NEVER** merge code automatically into `main`. A human developer must manually create the final pull request from `feature/phase-XX` into `main` and execute the merge.
- **Wrong Target Blocking**: Any PR targeting `main` must be immediately blocked, disapproved, and the agent corrected to retarget to the phase branch.
- **High-Risk Checks**: Any changes affecting authentication, security, schema/migrations, configurations/secrets, or government portal/auto-submit logic are classified as High Risk, blocking auto-merge and alerting the developer.

### 🤖 Model Recommendations & Routing
- **Primary Supervisor**: Use `gemini-3.1-flash-lite` (Provider: `google`) for normal orchestration and answering.
- **Backup Supervisor**: Use `qwen/qwen3.7-flash` via OpenRouter (Provider: `openrouter`) when the primary model fails or returns low confidence.
- **Strong Reviewer**: Use `gemini-3.5-flash` (Provider: `google`) to review high-risk changes.
- **Privacy Warning**: Never send real client immigration data, passport information, or documents to free/cheap models.

