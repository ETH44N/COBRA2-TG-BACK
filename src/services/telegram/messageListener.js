const Message = require('../../models/Message');
const Channel = require('../../models/Channel');
const { sendWebhookNotification } = require('../webhook/webhookService');
const logger = require('../../utils/logger');
const config = require('../../config/telegram');

// Rate limiting settings
const RATE_LIMIT = {
  messagesPerMinute: 20, // Maximum messages to process per minute per account
  cooldownMs: 60000 / 20, // Time between messages (defaults to 3 seconds)
  currentCount: {}, // Track current count of messages per account
  lastProcessed: {} // Track last processed time per account
};

// Message queue
const messageQueue = {
  queue: [],
  isProcessing: false
};

/**
 * Process a new message from a channel
 * @param {string} channelId - Channel ID (database ID)
 * @param {Object} message - Telegram message object
 * @param {Object} client - Telegram client
 * @param {string} accountId - Account ID processing this message
 */
const processNewMessage = async (channelId, message, client, accountId = null) => {
  try {
    logger.debug(`Processing new message for channel ${channelId}`, {
      source: 'message-listener',
      messageId: message.id,
      accountId
    });
    
    if (!channelId) {
      throw new Error('Channel ID is required');
    }
    
    if (!message || !message.id) {
      throw new Error('Valid message object with ID is required');
    }
    
    // Get channel from database
    const channel = await Channel.findById(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found in database`);
    }
    
    // Log message details for debugging
    logger.info(`Message details: ID=${message.id}, Channel=${channel.channel_id}`, {
      source: 'message-listener',
      message_type: message.className || 'unknown',
      has_media: !!message.media,
      date: message.date
    });
    
    // Check if message already exists
    const existingMessage = await Message.findOne({
      message_id: message.id,
      channel: channelId
    });
    
    if (existingMessage) {
      logger.debug(`Message ${message.id} already exists, skipping`, {
        source: 'message-listener'
      });
      return existingMessage;
    }
    
    // Extract message content
    let messageContent = '';
    if (message.message) {
      messageContent = message.message.toString().substring(0, 1000);
    }
    
    // Determine message type
    let messageType = 'text';
    let mediaType = null;
    let mediaData = null;
    
    if (message.media) {
      messageType = 'media';
      mediaType = message.media.className || 'unknown';
      mediaData = {
        type: mediaType,
        // Add appropriate media properties based on type
      };
    }
    
    // Create message record
    const newMessage = new Message({
      message_id: message.id,
      channel: channelId,
      content: messageContent,
      type: messageType,
      media_type: mediaType,
      media_data: mediaData,
      raw_data: JSON.stringify(message),
      created_at: message.date ? new Date(message.date * 1000) : new Date(),
      is_active: true
    });
    
    // Save message
    logger.info(`Saving new message ${message.id} for channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    await newMessage.save();
    
    // Update channel last activity
    await Channel.findByIdAndUpdate(channelId, {
      last_activity: new Date()
    });
    
    return newMessage;
  } catch (error) {
    logger.error(`Error processing new message: ${error.message}`, {
      source: 'message-listener',
      channelId,
      messageId: message?.id,
      accountId,
      stack: error.stack
    });
    
    throw error;
  }
};

/**
 * Process a deleted message from a channel
 * @param {string} channelId - Channel ID (database ID)
 * @param {number} messageId - Message ID
 * @param {string} accountId - Account ID processing this message
 */
const processDeletedMessage = async (channelId, messageId, accountId = null) => {
  try {
    logger.debug(`Processing deleted message ${messageId} for channel ${channelId}`, {
      source: 'message-listener',
      accountId
    });
    
    if (!channelId) {
      throw new Error('Channel ID is required');
    }
    
    // Get channel from database to ensure it exists
    const channel = await Channel.findById(channelId);
    if (!channel) {
      throw new Error(`Channel with ID ${channelId} not found`);
    }
    
    logger.debug(`Processing deleted message in channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    // Find the message
    const message = await Message.findOne({
      channel_id: channelId,
      message_id: messageId
    });
    
    if (!message) {
      logger.warn(`Message ${messageId} not found in channel ${channel.channel_id}`, {
        source: 'message-listener'
      });
      return null;
    }
    
    // Update message as deleted
    const updatedMessage = await Message.findByIdAndUpdate(
      message._id,
      {
        is_deleted: true,
        deleted_at: new Date()
      },
      { new: true }
    );
    
    logger.info(`Marked message ${updatedMessage._id} as deleted in channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    // Send webhook notification
    await sendWebhookNotification('deleted_message', {
      channel: {
        id: channel._id,
        name: channel.name,
        channel_id: channel.channel_id
      },
      message: {
        id: updatedMessage._id,
        message_id: updatedMessage.message_id,
        text: updatedMessage.text,
        sender_name: updatedMessage.sender_name,
        date: updatedMessage.date,
        deleted_at: updatedMessage.deleted_at
      }
    });
    
    return updatedMessage;
  } catch (error) {
    logger.error(`Error processing deleted message in channel ${channelId}: ${error.message}`, {
      source: 'message-listener',
      context: { error: error.stack }
    });
    throw error;
  }
};

/**
 * Queue a message for processing with rate limiting
 * @param {Object} messageTask - Task object with message details
 */
const queueMessageForProcessing = async (messageTask) => {
  logger.debug(`Queueing message for processing: ${JSON.stringify(messageTask)}`, {
    source: 'message-listener',
    accountId: messageTask.accountId,
    channelId: messageTask.channelId
  });
  
  messageQueue.queue.push(messageTask);
  
  // If queue processing isn't already running, start it
  if (!messageQueue.isProcessing) {
    processMessageQueue();
  }
  
  return true;
};

/**
 * Process the message queue with rate limiting
 */
const processMessageQueue = async () => {
  if (messageQueue.queue.length === 0) {
    messageQueue.isProcessing = false;
    return;
  }
  
  messageQueue.isProcessing = true;
  
  while (messageQueue.queue.length > 0) {
    const task = messageQueue.queue.shift();
    logger.debug(`Processing queued message task: ${JSON.stringify(task)}`, {
      source: 'message-listener',
      queueLength: messageQueue.queue.length,
      taskType: task.type
    });
    
    try {
      // Apply rate limiting
      const shouldThrottle = checkRateLimit(task.accountId);
      
      if (shouldThrottle) {
        // Put back at the front of the queue
        messageQueue.queue.unshift(task);
        
        // Wait for cooldown period
        setTimeout(processMessageQueue, RATE_LIMIT.cooldownMs);
        return;
      }
      
      // Process message based on type
      if (task.type === 'new') {
        await processNewMessage(task.channelId, task.message, task.client);
      } else if (task.type === 'deleted') {
        await processDeletedMessage(task.channelId, task.messageId);
      }
      
      // Update rate limiting counters
      updateRateLimit(task.accountId);
      
      // Process next message with slight delay
      setTimeout(processMessageQueue, 50);
    } catch (error) {
      logger.error(`Error in message queue processing: ${error.message}`, {
        source: 'message-listener',
        context: { error: error.stack, task }
      });
      
      // Continue with next message despite error
      setTimeout(processMessageQueue, 100);
    }
  }
};

/**
 * Check if rate limit should be applied for an account
 * @param {string} accountId - Account ID
 * @returns {boolean} - Whether throttling should be applied
 */
const checkRateLimit = (accountId) => {
  const now = Date.now();
  
  // Initialize tracking for this account if needed
  if (!RATE_LIMIT.lastProcessed[accountId]) {
    RATE_LIMIT.lastProcessed[accountId] = 0;
    RATE_LIMIT.currentCount[accountId] = 0;
    return false;
  }
  
  // Check time since last message and reset counter if needed
  const timeSinceLast = now - RATE_LIMIT.lastProcessed[accountId];
  if (timeSinceLast >= 60000) { // Reset after 1 minute
    RATE_LIMIT.currentCount[accountId] = 0;
    return false;
  }
  
  // Check if we've exceeded rate limits
  if (RATE_LIMIT.currentCount[accountId] >= RATE_LIMIT.messagesPerMinute) {
    // Calculate remaining cooldown time
    const cooldownNeeded = RATE_LIMIT.cooldownMs - timeSinceLast;
    
    if (cooldownNeeded > 0) {
      logger.warn(`Rate limit reached for account ${accountId}, throttling for ${cooldownNeeded}ms`, {
        source: 'message-listener'
      });
      return true;
    }
    
    // If cooldown period has passed, allow processing
    RATE_LIMIT.currentCount[accountId] = 0;
    return false;
  }
  
  return false;
};

/**
 * Update rate limit tracking after processing a message
 * @param {string} accountId - Account ID
 */
const updateRateLimit = (accountId) => {
  const now = Date.now();
  
  // Initialize tracking for this account if needed
  if (!RATE_LIMIT.lastProcessed[accountId]) {
    RATE_LIMIT.lastProcessed[accountId] = now;
    RATE_LIMIT.currentCount[accountId] = 1;
    return;
  }
  
  // Update last processed time and increment counter
  RATE_LIMIT.lastProcessed[accountId] = now;
  RATE_LIMIT.currentCount[accountId]++;
};

/**
 * Fetch message history for a channel
 * @param {string} channelId - Channel ID (database ID)
 * @param {Object} account - Account document
 * @param {Object} client - Telegram client
 * @param {number} limit - Maximum number of messages to fetch
 * @returns {Promise<number>} - Count of processed messages
 */
const fetchMessageHistory = async (channelId, account, client, limit = 20) => {
  try {
    const channel = await Channel.findById(channelId);
    if (!channel) {
      logger.error(`Cannot fetch history: Channel ${channelId} not found in database`, {
        source: 'message-listener'
      });
      return;
    }

    logger.info(`Fetching message history for channel ${channel.channel_id}`, {
      source: 'message-listener',
      accountId: account._id.toString()
    });

    // Get the entity for this channel
    let entity;
    try {
      entity = await client.getEntity(channel.channel_id);
      if (!entity) {
        logger.warn(`Could not get entity for channel ${channel.channel_id}`, {
          source: 'message-listener'
        });
        return;
      }
    } catch (error) {
      logger.error(`Error getting entity for channel ${channel.channel_id}: ${error.message}`, {
        source: 'message-listener',
        stack: error.stack
      });
      return;
    }

    // Fetch messages
    let messages;
    try {
      messages = await client.getMessages(entity, {
        limit: limit
      });
      
      logger.info(`Fetched ${messages.length} messages from channel ${channel.channel_id}`, {
        source: 'message-listener'
      });
    } catch (error) {
      logger.error(`Error fetching messages for channel ${channel.channel_id}: ${error.message}`, {
        source: 'message-listener',
        stack: error.stack
      });
      return;
    }

    // Process each message
    let processedCount = 0;
    for (const message of messages) {
      if (!message || !message.id) continue;
      
      try {
        // Check if we already have this message
        const existingMessage = await Message.findOne({
          channel_id: channelId,
          message_id: message.id.toString()
        });

        if (!existingMessage) {
          // Queue the message for processing
          await queueMessageForProcessing({
            type: 'new',
            channelId,
            message,
            client,
            accountId: account._id.toString()
          });
          processedCount++;
        }
      } catch (error) {
        logger.error(`Error processing message ${message.id} from history: ${error.message}`, {
          channelId,
          source: 'message-listener'
        });
      }
    }
    
    logger.info(`Processed ${processedCount} new messages from history for channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    // Update channel last checked time
    await Channel.findByIdAndUpdate(channelId, {
      last_checked: new Date()
    });
    
    return processedCount;
  } catch (error) {
    logger.error(`Error fetching message history: ${error.message}`, {
      channelId,
      source: 'message-listener',
      stack: error.stack
    });
    throw error;
  }
};

// Create messageListener object for easier importing
const messageListener = {
  processNewMessage,
  processDeletedMessage,
  fetchMessageHistory,
  queueMessageForProcessing,
  processMessageQueue,
  RATE_LIMIT,
  messageQueue
};

module.exports = {
  processNewMessage,
  processDeletedMessage,
  fetchMessageHistory,
  queueMessageForProcessing,
  RATE_LIMIT,
  messageQueue,
  messageListener
}; 