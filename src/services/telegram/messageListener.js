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
  // Add to queue if rate limiting is needed
  if (accountId) {
    return queueMessageForProcessing({
      type: 'new',
      channelId,
      message,
      client,
      accountId
    });
  }
  
  try {
    if (!channelId) {
      throw new Error('Channel ID is required');
    }
    
    // Get channel from database to ensure it exists
    const channel = await Channel.findById(channelId);
    if (!channel) {
      throw new Error(`Channel with ID ${channelId} not found`);
    }
    
    // Skip messages without an ID
    if (!message.id) {
      logger.warn(`Skipping message without ID in channel ${channel.channel_id}`, {
        source: 'message-listener',
        context: { messageData: JSON.stringify(message) }
      });
      return null;
    }
    
    logger.debug(`Processing new message in channel ${channel.channel_id}`, {
      source: 'message-listener',
      message_id: message.id
    });
    
    // Extract message data
    const messageData = {
      channel_id: channelId,
      message_id: message.id,
      sender_id: message.senderId ? message.senderId.toString() : null,
      sender_name: message.sender ? (message.sender.username || message.sender.firstName || 'Unknown') : 'Unknown',
      text: message.text || '',
      raw_data: JSON.stringify(message),
      date: new Date(message.date * 1000), // Convert Unix timestamp to Date
      is_deleted: false
    };
    
    // Check for media
    if (message.media) {
      messageData.has_media = true;
      
      // Determine media type
      if (message.media.photo) {
        messageData.media_type = 'photo';
      } else if (message.media.document) {
        messageData.media_type = 'document';
      } else if (message.media.video) {
        messageData.media_type = 'video';
      } else if (message.media.audio) {
        messageData.media_type = 'audio';
      } else {
        messageData.media_type = 'other';
      }
      
      // Try to get media URL if available
      try {
        if (client && message.media.photo) {
          // For photos, get the largest size
          const photo = message.media.photo;
          const fileLocation = photo.sizes[photo.sizes.length - 1].location;
          
          // Download or get URL
          // This is a placeholder - actual implementation depends on Telegram client capabilities
          // messageData.media_url = await client.getFileUrl(fileLocation);
        }
      } catch (error) {
        logger.warn(`Could not get media URL for message ${message.id}: ${error.message}`, {
          source: 'message-listener'
        });
      }
    }
    
    // Check if this message already exists to avoid duplicates
    const existingMessage = await Message.findOne({
      channel_id: channelId,
      message_id: message.id
    });
    
    if (existingMessage) {
      logger.debug(`Message ${message.id} already exists in channel ${channel.channel_id}, skipping`, {
        source: 'message-listener'
      });
      return existingMessage;
    }
    
    // Save to database - use findOneAndUpdate with upsert to avoid duplicates
    const savedMessage = await Message.findOneAndUpdate(
      { channel_id: channelId, message_id: message.id },
      messageData,
      { upsert: true, new: true }
    );
    
    logger.info(`Saved message ${savedMessage.message_id} from channel ${channel.channel_id}`, {
      source: 'message-listener',
      message_id: savedMessage.message_id
    });
    
    // Send webhook notification
    await sendWebhookNotification('new_message', {
      channel_id: channel.channel_id,
      message_id: savedMessage.message_id,
      text: savedMessage.text,
      sender: savedMessage.sender_name,
      has_media: savedMessage.has_media,
      media_type: savedMessage.media_type
    });
    
    return savedMessage;
  } catch (error) {
    logger.error(`Error processing new message in channel ${channelId}: ${error.message}`, {
      source: 'message-listener',
      context: { error: error.stack }
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
  // Add to queue if rate limiting is needed
  if (accountId) {
    return queueMessageForProcessing({
      type: 'deleted',
      channelId,
      messageId,
      accountId
    });
  }
  
  try {
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
  // Add to queue
  messageQueue.queue.push(messageTask);
  
  // Start processing if not already running
  if (!messageQueue.isProcessing) {
    processMessageQueue();
  }
  
  return { queued: true };
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
  
  // Get the next task
  const task = messageQueue.queue.shift();
  
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
 * @param {Object} channel - Channel document
 * @param {Object} account - Account document
 * @param {Object} client - Telegram client
 * @param {number} limit - Maximum number of messages to fetch
 * @returns {Promise<Object>} - Result object with count of processed messages
 */
const fetchMessageHistory = async (channel, account, client, limit = 100) => {
  try {
    if (!client) {
      throw new Error(`No active client for account ${account.phone_number}`);
    }
    
    logger.info(`Fetching up to ${limit} messages from channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    // Get the channel entity
    const entity = await client.getEntity(channel.channel_id);
    
    // Get message history
    const messages = await client.getMessages(entity, {
      limit: limit
    });
    
    logger.info(`Fetched ${messages.length} historical messages for channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    // Process each message
    let processedCount = 0;
    for (const message of messages) {
      try {
        // Skip messages without an ID
        if (!message.id) {
          logger.warn(`Skipping historical message without ID in channel ${channel.channel_id}`, {
            source: 'message-listener'
          });
          continue;
        }
        
        // Queue message for processing
        await queueMessageForProcessing({
          type: 'new',
          channelId: channel._id,
          message,
          client,
          accountId: account._id.toString()
        });
        
        processedCount++;
      } catch (error) {
        logger.error(`Error processing historical message: ${error.message}`, {
          source: 'message-listener',
          context: { error: error.stack }
        });
      }
    }
    
    // Update channel last_checked
    await Channel.findByIdAndUpdate(channel._id, {
      last_checked: new Date()
    });
    
    return {
      success: true,
      count: processedCount,
      queueLength: messageQueue.queue.length
    };
  } catch (error) {
    logger.error(`Error fetching message history for channel ${channel.channel_id}: ${error.message}`, {
      source: 'message-listener',
      context: { error: error.stack }
    });
    throw error;
  }
};

module.exports = {
  processNewMessage,
  processDeletedMessage,
  fetchMessageHistory,
  queueMessageForProcessing,
  RATE_LIMIT,
  messageQueue
}; 