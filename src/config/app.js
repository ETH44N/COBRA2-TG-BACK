module.exports = {
  port: process.env.PORT || 3000,
  environment: process.env.NODE_ENV || 'development',
  defaultWebhookUrl: process.env.DEFAULT_WEBHOOK_URL,
  webhookSecret: process.env.WEBHOOK_SECRET,
  logLevel: process.env.LOG_LEVEL || 'info',
  webhookRetryLimit: parseInt(process.env.WEBHOOK_RETRY_LIMIT || '3', 10),
  webhookRetryDelay: parseInt(process.env.WEBHOOK_RETRY_DELAY || '60000', 10) // 1 minute
}; 