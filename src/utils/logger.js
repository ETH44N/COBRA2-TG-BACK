const winston = require('winston');
const Log = require('../models/Log');

// Custom MongoDB transport for Winston
class MongoTransport extends winston.Transport {
  constructor(opts) {
    super(opts);
    this.name = 'mongodb';
    this.level = opts.level || 'info';
  }

  async log(info, callback) {
    try {
      const { level, message, ...rest } = info;
      const { account_id, channel_id, source } = rest;
      
      await Log.create({
        level,
        message,
        context: rest,
        account_id,
        channel_id,
        source,
        timestamp: new Date()
      });
      
      callback(null, true);
    } catch (error) {
      console.error('Error saving log to MongoDB:', error);
      callback(error);
    }
  }
}

// Create Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'telegram-monitor' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Add MongoDB transport in production
if (process.env.NODE_ENV === 'production') {
  logger.add(new MongoTransport({ level: 'info' }));
}

module.exports = logger; 