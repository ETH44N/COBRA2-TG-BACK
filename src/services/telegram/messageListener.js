const Message = require('../../models/Message');
const Channel = require('../../models/Channel');
const { sendWebhookNotification } = require('../webhook/webhookService');
const logger = require('../../utils/logger');
const config = require('../../config/telegram');

// Rate limiting configuration
const RATE_LIMIT = {
  maxMessagesPerMinute: 30,
  windowMs: 60 * 1000  // 1 minute
};

// Rate limiting state
const rateLimits = new Map();

// Message queue
const messageQueue = {
  queue: [],
  isProcessing: false
};

/**
 * Process a new message
 * @param {string} channelId - Channel ID
 * @param {Object} message - Message data
 * @param {Object} client - Telegram client
 * @param {string} accountId - Account ID
 * @returns {Promise<Object|null>} - Saved message or null
 */
const processNewMessage = async (channelId, message, client, accountId = null) => {
  try {
    // Basic validation
    if (!message || !message.id) {
      logger.error(`Cannot process message without ID for channel ${channelId}`, {
        source: 'message-listener'
      });
      return null;
    }
    
    logger.debug(`Processing new message ${message.id} for channel ${channelId}`, {
      source: 'message-listener',
      accountId
    });
    
    // Check if the channel exists
    const channel = await Channel.findById(channelId);
    if (!channel) {
      logger.error(`Channel ${channelId} not found in database`, {
        source: 'message-listener'
      });
      return null;
    }
    
    // Check if this message already exists (avoid duplicates)
    const existingMessage = await Message.findOne({
      channel_id: channelId,
      message_id: message.id
    });
    
    if (existingMessage) {
      logger.debug(`Message ${message.id} already exists in database, skipping`, {
        source: 'message-listener',
        messageId: message.id,
        channelId
      });
      return existingMessage;
    }
    
    // Determine media type
    let mediaType = 'none';
    let mediaUrls = null;
    
    if (message.media) {
      if (message.media.photo) {
        mediaType = 'photo';
      } else if (message.media.document) {
        mediaType = message.media.document.mimeType && message.media.document.mimeType.startsWith('video/')
          ? 'video'
          : 'document';
      } else if (message.media.type) {
        mediaType = message.media.type.toLowerCase();
      }
    }
    
    // Get content text
    const content = message.text || message.message || '';
    
    // Create new message record
    const newMessage = new Message({
      channel_id: channelId,
      message_id: message.id,
      content: content,
      text: content,
      date: new Date(message.date * 1000), // Convert Unix timestamp to JS Date
      sender_id: message.fromId ? message.fromId.toString() : null,
      sender_name: message.sender ? message.sender.toString() : null,
      is_deleted: false,
      media_type: mediaType,
      media_urls: mediaUrls
    });
    
    // Save to database
    await newMessage.save();
    
    // Update channel last_message_at
    await Channel.findByIdAndUpdate(channelId, {
      last_message_at: new Date()
    });
    
    logger.info(`Saved new message ${message.id} for channel ${channel.channel_id}`, {
      source: 'message-listener',
      messageId: message.id,
      channelId
    });
    
    return newMessage;
  } catch (error) {
    logger.error(`Error processing new message: ${error.message}`, {
      source: 'message-listener',
      stack: error.stack,
      channelId,
      messageId: message?.id
    });
    return null;
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
 * Add a message task to the processing queue
 * @param {Object} messageTask - Task containing message data to process
 * @param {string} messageTask.type - 'new' or 'deleted'
 * @param {string} messageTask.channelId - Channel ID in database
 * @param {Object} messageTask.message - Message data for new messages
 * @param {number} messageTask.messageId - Message ID for deleted messages
 * @param {Object} messageTask.client - Optional Telegram client
 * @param {string} messageTask.accountId - Account ID used for this task
 * @param {boolean} messageTask.skipExistCheck - Skip checking if message exists (for performance)
 * @returns {Promise<Object|null>} - Processed message or null
 */
const queueMessageForProcessing = async (messageTask) => {
  try {
    if (!messageTask || !messageTask.type || !messageTask.channelId) {
      logger.error(`Invalid message task`, {
        source: 'message-listener',
        task: JSON.stringify(messageTask)
      });
      return null;
    }
    
    // Rate limiting check
    if (!checkRateLimit(messageTask.accountId)) {
      logger.warn(`Rate limit exceeded for account ${messageTask.accountId}, skipping message task`, {
        source: 'message-listener',
        type: messageTask.type
      });
      return null;
    }
    
    // Update rate limit counter
    updateRateLimit(messageTask.accountId);
    
    // Log queuing of the task
    logger.debug(`Queuing message task: ${messageTask.type}`, {
      source: 'message-listener',
      channelId: messageTask.channelId,
      messageId: messageTask.type === 'new' ? messageTask.message?.id : messageTask.messageId
    });
    
    // For immediate processing without queuing:
    if (messageTask.type === 'new' && messageTask.message) {
      if (!messageTask.skipExistCheck) {
        // Check if message already exists
        const existingMessage = await Message.findOne({
          channel_id: messageTask.channelId,
          message_id: messageTask.message.id
        });
        
        if (existingMessage) {
          logger.debug(`Message ${messageTask.message.id} already exists for channel ${messageTask.channelId}, skipping`, {
            source: 'message-listener'
          });
          return null;
        }
      }
      
      return await processNewMessage(
        messageTask.channelId,
        messageTask.message,
        messageTask.client,
        messageTask.accountId
      );
    } else if (messageTask.type === 'deleted' && messageTask.messageId) {
      return await processDeletedMessage(
        messageTask.channelId,
        messageTask.messageId,
        messageTask.accountId
      );
    }
    
    // Add to queue otherwise
    messageQueue.queue.push(messageTask);
    
    // Trigger queue processing if not already running
    if (!messageQueue.isProcessing) {
      processMessageQueue();
    }
    
    return null;
  } catch (error) {
    logger.error(`Error queueing message task: ${error.message}`, {
      source: 'message-listener',
      stack: error.stack,
      taskType: messageTask?.type
    });
    return null;
  }
};

/**
 * Process the message queue with rate limiting
 */
const processMessageQueue = async () => {
  try {
    if (messageQueue.isProcessing || messageQueue.queue.length === 0) {
      return;
    }
    
    messageQueue.isProcessing = true;
    
    while (messageQueue.queue.length > 0) {
      const task = messageQueue.queue.shift();
      
      try {
        // Check rate limit before processing
        if (task.accountId && checkRateLimit(task.accountId)) {
          logger.debug(`Rate limit exceeded for account ${task.accountId}, delaying task`, {
            source: 'message-listener'
          });
          
          // Put back at end of queue
          messageQueue.queue.push(task);
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
        // Process based on message type
        if (task.type === 'new') {
          // Extract only the necessary data from the message to avoid circular references
          const extractedMessage = extractMessageData(task.message);
          await processNewMessage(task.channelId, extractedMessage, task.client, task.accountId);
        } else if (task.type === 'deleted') {
          await processDeletedMessage(task.channelId, task.messageId, task.accountId);
        }
        
        // Update rate limit if needed
        if (task.accountId) {
          updateRateLimit(task.accountId);
        }
      } catch (taskError) {
        logger.error(`Error processing message task: ${taskError.message}`, {
          source: 'message-listener',
          taskType: task.type,
          channelId: task.channelId,
          stack: taskError.stack
        });
      }
      
      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    messageQueue.isProcessing = false;
  } catch (error) {
    logger.error(`Error in queue processing: ${error.message}`, {
      source: 'message-listener',
      stack: error.stack
    });
    messageQueue.isProcessing = false;
  }
};

/**
 * Safely extract data from a Telegram message object to avoid circular references
 * @param {Object} message - Telegram message object
 * @returns {Object} - Extracted message data
 */
const extractMessageData = (message) => {
  if (!message) return null;
  
  try {
    return {
      id: message.id,
      text: message.text || message.message || '',
      date: message.date,
      peerId: message.peerId ? {
        channelId: message.peerId.channelId,
        userId: message.peerId.userId
      } : null,
      chatId: message.chatId,
      fromId: message.fromId,
      sender: message.sender,
      media: message.media ? {
        type: message.media.constructor?.name || 'Unknown',
        photo: message.media.photo ? {
          id: message.media.photo.id,
          accessHash: message.media.photo.accessHash,
        } : null,
        document: message.media.document ? {
          id: message.media.document.id,
          mimeType: message.media.document.mimeType,
        } : null
      } : null
    };
  } catch (error) {
    logger.error(`Error extracting message data: ${error.message}`, {
      source: 'message-listener',
      stack: error.stack,
      messageId: message.id
    });
    
    // Return minimal data if extraction fails
    return {
      id: message.id,
      text: message.text || message.message || '',
      date: message.date
    };
  }
};

/**
 * Check if an account has exceeded rate limits
 * @param {string} accountId - Account ID
 * @returns {boolean} - False if rate limit exceeded, true otherwise
 */
const checkRateLimit = (accountId) => {
  if (!accountId) return true;
  
  const now = Date.now();
  
  // Initialize rate limit tracking for this account if needed
  if (!rateLimits.has(accountId)) {
    rateLimits.set(accountId, {
      count: 0,
      resetAt: now + RATE_LIMIT.windowMs
    });
    return true;
  }
  
  const limit = rateLimits.get(accountId);
  
  // Reset window if needed
  if (now > limit.resetAt) {
    limit.count = 0;
    limit.resetAt = now + RATE_LIMIT.windowMs;
    return true;
  }
  
  // Check if within limit
  return limit.count < RATE_LIMIT.maxMessagesPerMinute;
};

/**
 * Update rate limit counter for an account
 * @param {string} accountId - Account ID
 */
const updateRateLimit = (accountId) => {
  if (!accountId) return;
  
  const now = Date.now();
  
  // Initialize rate limit tracking for this account if needed
  if (!rateLimits.has(accountId)) {
    rateLimits.set(accountId, {
      count: 1,
      resetAt: now + RATE_LIMIT.windowMs
    });
    return;
  }
  
  const limit = rateLimits.get(accountId);
  
  // Reset window if needed
  if (now > limit.resetAt) {
    limit.count = 1;
    limit.resetAt = now + RATE_LIMIT.windowMs;
  } else {
    // Increment counter
    limit.count++;
  }
};

/**
 * Fetch message history for a channel and save new messages
 * @param {string} channelId - Channel ID in our database
 * @param {Object} account - Account object from database
 * @param {Object} client - Telegram client
 * @param {number} limit - Maximum number of messages to fetch
 * @returns {Promise<Array>} - Array of saved messages
 */
const fetchMessageHistory = async (channelId, account, client, limit = 20) => {
  try {
    logger.info(`Fetching message history for channel ${channelId} using account ${account._id || account.phone_number}, limit: ${limit}`, {
      source: 'message-listener'
    });
    
    // Get channel from database
    const channel = await Channel.findById(channelId);
    if (!channel) {
      logger.error(`Channel not found: ${channelId}`, {
        source: 'message-listener'
      });
      return [];
    }
    
    // Get channel entity
    let entity;
    try {
      entity = await client.getEntity(channel.channel_id);
    } catch (error) {
      logger.error(`Cannot get entity for channel ${channel.channel_id}: ${error.message}`, {
        source: 'message-listener',
        stack: error.stack
      });
      return [];
    }
    
    // Get message history
    let messages;
    try {
      logger.debug(`Getting message history for ${entity.id} (${entity.title || entity.username})`, {
        source: 'message-listener'
      });
      
      messages = await client.getMessages(entity, {
        limit: limit
      });
      
      logger.info(`Retrieved ${messages.length} messages for channel ${channel.channel_id}`, {
        source: 'message-listener'
      });
    } catch (error) {
      logger.error(`Error getting messages for channel ${channel.channel_id}: ${error.message}`, {
        source: 'message-listener',
        stack: error.stack
      });
      return [];
    }
    
    if (!messages || !messages.length) {
      logger.debug(`No messages found for channel ${channel.channel_id}`, {
        source: 'message-listener'
      });
      return [];
    }
    
    // Track message IDs to avoid duplicates
    const processedMessageIds = new Set();
    const savedMessages = [];
    
    // Process each message
    for (const message of messages) {
      try {
        if (!message || !message.id) {
          logger.debug(`Skipping message with no ID for channel ${channel.channel_id}`, {
            source: 'message-listener'
          });
          continue;
        }
        
        // Skip duplicates within this batch
        if (processedMessageIds.has(message.id)) {
          continue;
        }
        
        processedMessageIds.add(message.id);
        
        // Extract safe message data
        const messageData = extractMessageData(message);
        
        // Queue for processing
        const result = await queueMessageForProcessing({
          type: 'new',
          channelId: channelId,
          message: messageData,
          client,
          accountId: account._id.toString(),
          skipExistCheck: false  // Always check if message exists to avoid duplicates
        });
        
        if (result) {
          savedMessages.push(result);
        }
      } catch (messageError) {
        logger.error(`Error processing message ${message.id} for channel ${channel.channel_id}: ${messageError.message}`, {
          source: 'message-listener',
          stack: messageError.stack
        });
      }
    }
    
    // Update channel
    await Channel.findByIdAndUpdate(channelId, {
      last_message_at: new Date()
    });
    
    logger.info(`Saved ${savedMessages.length} new messages from history for channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    return savedMessages;
  } catch (error) {
    logger.error(`Error fetching message history for channel ${channelId}: ${error.message}`, {
      source: 'message-listener',
      stack: error.stack
    });
    return [];
  }
};

// Create a messageListener object for export
const messageListener = {
  processNewMessage,
  processDeletedMessage,
  queueMessageForProcessing,
  processMessageQueue,
  fetchMessageHistory,
  extractMessageData,
  checkRateLimit,
  updateRateLimit
};

module.exports = {
  processNewMessage,
  processDeletedMessage,
  queueMessageForProcessing,
  processMessageQueue,
  fetchMessageHistory,
  extractMessageData,
  checkRateLimit,
  updateRateLimit,
  messageListener
}; 