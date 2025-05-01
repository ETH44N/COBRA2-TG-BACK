/**
 * Test script for message polling
 * 
 * This script tests the polling mechanism for fetching messages from Telegram channels.
 * It's designed to work around the GramJS issue with event handlers not properly dispatching events.
 */

const mongoose = require('mongoose');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const logger = require('../utils/logger');
const Account = require('../models/Account');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
// Remove the import that might be causing issues
// const { extractMessageData } = require('../services/telegram/messageListener');
require('dotenv').config();

// Implement extractMessageData directly in this file
/**
 * Safely extract data from a Telegram message object to avoid circular references
 * @param {Object} message - Telegram message object
 * @returns {Object} - Clean message data
 */
function extractMessageData(message) {
  if (!message || typeof message !== 'object') {
    return {
      id: null,
      text: '',
      date: new Date(),
      hasMedia: false,
      mediaType: null,
      chat: { id: null, title: null }
    };
  }

  try {
    // Extract basic message properties
    const data = {
      id: message.id || null,
      text: message.text || message.message || '',
      date: message.date ? new Date(message.date * 1000) : new Date(),
      hasMedia: false,
      mediaType: null,
      chat: {
        id: message.chatId || (message.chat ? message.chat.id : null),
        title: message.chat ? (message.chat.title || message.chat.username || null) : null
      }
    };

    // Check for media
    if (message.media) {
      data.hasMedia = true;
      // Determine media type
      if (message.media.photo) {
        data.mediaType = 'photo';
      } else if (message.media.document) {
        data.mediaType = 'document';
        if (message.media.document.mimeType && message.media.document.mimeType.startsWith('video/')) {
          data.mediaType = 'video';
        }
      } else if (message.media.webpage) {
        data.mediaType = 'webpage';
        // Extract additional text from webpage if available
        if (message.media.webpage.description) {
          data.text += '\n' + message.media.webpage.description;
        }
      }
    }

    return data;
  } catch (error) {
    console.error('Error extracting message data:', error);
    return {
      id: message.id || null,
      text: 'Error extracting message content',
      date: new Date(),
      hasMedia: false,
      mediaType: null,
      chat: { id: null, title: null }
    };
  }
}

// Make sure we have API credentials
const API_ID = process.env.TELEGRAM_API_ID;
const API_HASH = process.env.TELEGRAM_API_HASH;

if (!API_ID || !API_HASH) {
  console.error("ERROR: Telegram API credentials not found in environment variables.");
  console.error("Please make sure TELEGRAM_API_ID and TELEGRAM_API_HASH are set in .env file.");
  process.exit(1);
}

console.log("Using Telegram API credentials:");
console.log(`API_ID: ${API_ID}`);
console.log(`API_HASH: ${API_HASH.substring(0, 4)}...${API_HASH.substring(API_HASH.length - 4)}`); // Only show part of the hash for security

// Set up MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('Connected to MongoDB', { source: 'test-polling' });
  runTest();
})
.catch(err => {
  logger.error(`MongoDB connection error: ${err.message}`, { 
    source: 'test-polling',
    stack: err.stack
  });
  process.exit(1);
});

/**
 * Create a Telegram client for testing
 * @param {Object} account - Account object from database
 * @returns {Promise<Object>} - Telegram client
 */
async function createClient(account) {
  try {
    logger.info(`Creating client for account ${account.phone_number || account._id}`, {
      source: 'test-polling'
    });
    
    const session = new StringSession(account.session_string);
    const client = new TelegramClient(
      session,
      parseInt(API_ID, 10),  // Make sure it's an integer
      API_HASH,
      {
        connectionRetries: 5,
        retryDelay: 1000,
        useWSS: false,
        timeout: 10000
      }
    );
    
    await client.connect();
    if (!client.connected) {
      throw new Error('Failed to connect client');
    }
    
    logger.info(`Client connected for account ${account.phone_number || account._id}`, {
      source: 'test-polling'
    });
    
    return client;
  } catch (error) {
    logger.error(`Error creating client: ${error.message}`, {
      source: 'test-polling',
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Run the polling test
 */
async function runTest() {
  try {
    logger.info('Starting polling test', { source: 'test-polling' });
    
    // Get accounts
    const accounts = await Account.find({ status: 'active' }).limit(1);
    if (!accounts.length) {
      logger.error('No active accounts found', { source: 'test-polling' });
      process.exit(1);
    }
    
    const account = accounts[0];
    logger.info(`Using account ${account.phone_number || account._id}`, {
      source: 'test-polling'
    });
    
    // Get channel
    const channels = await Channel.find({ is_active: true }).limit(1);
    if (!channels.length) {
      logger.error('No active channels found', { source: 'test-polling' });
      process.exit(1);
    }
    
    const channel = channels[0];
    logger.info(`Testing with channel ${channel.name || channel.channel_id}`, {
      source: 'test-polling'
    });
    
    // Create client
    const client = await createClient(account);
    
    // Get channel entity
    const entity = await client.getEntity(channel.channel_id);
    if (!entity) {
      logger.error(`Could not get entity for channel ${channel.channel_id}`, {
        source: 'test-polling'
      });
      process.exit(1);
    }
    
    logger.info(`Got entity for channel: ${entity.title || entity.username || entity.id}`, {
      source: 'test-polling'
    });
    
    // Fetch messages
    logger.info(`Fetching messages for channel ${channel.channel_id}`, {
      source: 'test-polling'
    });
    
    const messages = await client.getMessages(entity, {
      limit: 5
    });
    
    logger.info(`Retrieved ${messages.length} messages`, {
      source: 'test-polling'
    });
    
    // Process messages
    for (const message of messages) {
      try {
        if (!message || !message.id) continue;
        
        const extractedData = extractMessageData(message);
        logger.info(`Message ${message.id}: ${extractedData.text.substring(0, 50)}...`, {
          source: 'test-polling'
        });
        
        // Check if message exists in database
        const existingMessage = await Message.findOne({
          channel_id: channel._id,
          message_id: message.id
        });
        
        if (existingMessage) {
          logger.info(`Message ${message.id} already exists in database`, {
            source: 'test-polling'
          });
        } else {
          logger.info(`Message ${message.id} is new, would save to database`, {
            source: 'test-polling'
          });
        }
      } catch (error) {
        logger.error(`Error processing message: ${error.message}`, {
          source: 'test-polling',
          stack: error.stack
        });
      }
    }
    
    logger.info('Test completed successfully', { source: 'test-polling' });
    
    // Disconnect client and close MongoDB connection
    await client.disconnect();
    await mongoose.connection.close();
    
    process.exit(0);
  } catch (error) {
    logger.error(`Test failed: ${error.message}`, {
      source: 'test-polling',
      stack: error.stack
    });
    
    try {
      await mongoose.connection.close();
    } catch (closeError) {
      console.error('Error closing MongoDB connection:', closeError);
    }
    
    process.exit(1);
  }
} 