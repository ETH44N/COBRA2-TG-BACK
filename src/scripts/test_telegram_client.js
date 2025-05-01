/**
 * Test script to verify Telegram client functionality
 * 
 * Run with: node src/scripts/test_telegram_client.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { TelegramClient } = require('telegram');
const { NewMessage, Raw } = require('telegram/events');

// Import models
const Account = require('../models/Account');
const Channel = require('../models/Channel');

// Configure logger
const winston = require('winston');
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Connect to database
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    logger.info('Connected to MongoDB');
    runTest();
  })
  .catch(err => {
    logger.error('MongoDB connection error:', err);
    process.exit(1);
  });

/**
 * Create Telegram client for account
 */
async function createClient(account) {
  if (!account || !account.session_string) {
    throw new Error('Invalid account or missing session string');
  }

  logger.info(`Creating client for account ${account.phone_number}`);

  const stringSession = new StringSession(account.session_string);

  const client = new TelegramClient(
    stringSession,
    parseInt(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    {
      connectionRetries: 5,
      baseLogger: logger
    }
  );

  // Connect to Telegram
  await client.connect();
  
  if (!client.connected) {
    throw new Error('Failed to connect client to Telegram');
  }

  logger.info(`Client for account ${account.phone_number} connected successfully`);
  return client;
}

/**
 * Run the test
 */
async function runTest() {
  try {
    // Get one active account
    const account = await Account.findOne({ 
      status: 'active',
      isBanned: { $ne: true } 
    });

    if (!account) {
      logger.error('No active accounts found');
      mongoose.disconnect();
      return;
    }

    logger.info(`Testing with account: ${account.phone_number}`);

    // Create client
    const client = await createClient(account);
    
    // Log account info
    const me = await client.getMe();
    logger.info(`Logged in as: ${me.username || me.phone} (ID: ${me.id})`);

    // Get channels
    const channels = await Channel.find({ 
      is_active: true,
      account_id: account._id
    }).limit(3);

    if (channels.length === 0) {
      logger.error('No active channels found for this account');
      await client.disconnect();
      mongoose.disconnect();
      return;
    }

    logger.info(`Found ${channels.length} channels to test`);

    // Test event handling
    logger.info('Testing event handling...');
    
    // Create message handler
    const messageHandler = (event) => {
      logger.info('Received message event:', {
        className: event.className,
        chatId: event.chatId,
        hasMessage: !!event.message,
        messageId: event.message?.id
      });
      
      if (event.message) {
        logger.info('Message content:', {
          id: event.message.id,
          text: event.message.text?.substring(0, 100),
          hasMedia: !!event.message.media
        });
      }
    };

    // Create raw update handler
    const rawHandler = (update) => {
      logger.info('Received raw update:', {
        className: update?.className,
        updateType: update?.constructor?.name
      });
      
      // Check for message deletions
      if (update?.className === 'UpdateDeleteChannelMessages') {
        logger.info('Detected deleted messages:', {
          channelId: update.channelId,
          messages: update.messages
        });
      }
    };

    // Register handlers
    client.addEventHandler(messageHandler, new NewMessage({}));
    client.addEventHandler(rawHandler, new Raw({}));
    
    logger.info('Event handlers registered, waiting for events...');
    logger.info('Will attempt to fetch messages from channels as well...');

    // Test message fetching for each channel
    for (const channel of channels) {
      try {
        logger.info(`Testing channel: ${channel.title} (${channel.channel_id})`);
        
        // Get channel entity
        const entity = await client.getEntity(channel.channel_id);
        logger.info('Got channel entity:', {
          id: entity.id,
          title: entity.title,
          username: entity.username,
          type: entity.constructor.name
        });
        
        // Fetch recent messages
        logger.info('Fetching recent messages...');
        const messages = await client.getMessages(entity, { limit: 5 });
        
        logger.info(`Fetched ${messages.length} messages`);
        
        // Log message details
        for (const message of messages) {
          if (message && message.id) {
            logger.info('Message:', {
              id: message.id,
              date: message.date,
              text: message.text?.substring(0, 100),
              hasMedia: !!message.media
            });
          }
        }
      } catch (error) {
        logger.error(`Error testing channel ${channel.channel_id}:`, error);
      }
    }

    // Keep running for 30 seconds to catch events
    logger.info('Waiting for 30 seconds to receive any events...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    logger.info('Test complete, disconnecting');
    await client.disconnect();
    await mongoose.disconnect();
    
    logger.info('Test script finished');
    process.exit(0);
  } catch (error) {
    logger.error('Error in test script:', error);
    try {
      await mongoose.disconnect();
    } catch (e) {
      // Ignore
    }
    process.exit(1);
  }
} 