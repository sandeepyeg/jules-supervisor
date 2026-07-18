import dotenv from 'dotenv';

if (process.env.JULES_SUPERVISOR_TEST === '1') {
  process.env.PORTAL_SECRET ||= 'test_portal_secret';
  process.env.TELEGRAM_BOT_TOKEN = 'your_telegram_bot_token';
  process.env.TELEGRAM_CHAT_ID ||= 'test_chat';
  process.env.GITHUB_TOKEN ||= 'test_github_token';
  process.env.GITHUB_OWNER ||= 'test_owner';
  process.env.GITHUB_REPO ||= 'test_repo';
  process.env.JULES_API_KEY ||= 'test_jules_api_key';
  process.env.GEMINI_API_KEY ||= 'test_gemini_api_key';
  process.env.OPENROUTER_API_KEY ||= 'test_openrouter_api_key';
} else {
  dotenv.config({ override: true });
  console.log('Environment variables loaded successfully.');
}
