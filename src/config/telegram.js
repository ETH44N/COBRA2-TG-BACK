module.exports = {
  apiId: parseInt(process.env.TELEGRAM_API_ID, 10),
  apiHash: process.env.TELEGRAM_API_HASH,
  maxReconnects: 5,
  reconnectDelay: 5000, // 5 seconds
  maxChannelsPerAccount: parseInt(process.env.MAX_CHANNELS_PER_ACCOUNT || '50', 10),
  messageHistoryLimit: parseInt(process.env.MESSAGE_HISTORY_LIMIT || '100', 10)
}; 