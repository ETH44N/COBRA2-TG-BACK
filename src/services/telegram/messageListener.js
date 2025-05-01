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
 * Process a new message
 */
const processNewMessage = async (channelId, message, client, accountId = null) => {
  try {
    if (!message || !message.id) {
      logger.error('Invalid message object', { 
        source: 'message-listener',
        channelId
      });
      return;
    }
    
    // Log message details for debugging
    logger.debug(`Processing new message ${message.id}`, {
      channelId,
      messageId: message.id,
      hasMedia: !!message.media,
      source: 'message-listener'
    });
    
    // Get the channel from the database
    const channel = await Channel.findById(channelId);
    if (!channel) {
      logger.error(`Channel not found in database: ${channelId}`, {
        source: 'message-listener'
      });
      return;
    }
    
    // Check if message already exists to avoid duplicates
    const existingMessage = await Message.findOne({
      channel_id: channelId,
      message_id: message.id.toString()
    });
    
    if (existingMessage) {
      logger.debug(`Message ${message.id} already exists for channel ${channel.channel_id}`, {
        source: 'message-listener'
      });
      return;
    }
    
    // Extract content and determine message type
    let content = message.text || '';
    let messageType = 'text';
    
    // Handle media content
    if (message.media) {
      messageType = 'media';
      const mediaType = message.media.type || 'unknown';
      
      if (message.media.photo) {
        content = `[Photo: ${message.media.photo.id}]${content ? ' ' + content : ''}`;
      } else if (message.media.document) {
        content = `[Document: ${message.media.document.mimeType}]${content ? ' ' + content : ''}`;
      } else {
        content = `[Media: ${mediaType}]${content ? ' ' + content : ''}`;
      }
    }
    
    // Create a new message record
    const newMessage = new Message({
      channel_id: channelId,
      message_id: message.id.toString(),
      content: content,
      type: messageType,
      created_at: new Date(message.date * 1000) || new Date(),
      is_deleted: false,
      processed: true,
      metadata: {
        raw_text: message.text || '',
        has_media: !!message.media,
        media_type: message.media ? message.media.type : null,
        account_id: accountId
      }
    });
    
    // Save the message to the database
    await newMessage.save();
    
    // Update channel last_message_at
    await Channel.findByIdAndUpdate(channelId, {
      last_activity: new Date(),
      last_message_at: new Date()
    });
    
    logger.info(`Added new message ${message.id} for channel ${channel.channel_id}`, {
      source: 'message-listener'
    });
    
    return newMessage;
  } catch (error) {
    logger.error(`Error processing new message: ${error.message}`, {
      channelId,
      messageId: message?.id,
      source: 'message-listener',
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
  try {
    // Add to queue
    messageQueue.queue.push(messageTask);
    
    logger.debug(`Queued ${messageTask.type} message task for processing`, {
      source: 'message-listener',
      taskType: messageTask.type,
      channelId: messageTask.channelId,
      messageId: messageTask.type === 'new' ? messageTask.message?.id : messageTask.messageId
    });
    
    // Start processing if not already in progress
    if (!messageQueue.isProcessing) {
      processMessageQueue();
    }
  } catch (error) {
    logger.error(`Error queuing message: ${error.message}`, {
      source: 'message-listener',
      stack: error.stack
    });
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
 * Extract only the necessary data from a message to avoid circular references
 */
const extractMessageData = (message) => {
  if (!message) return null;
  
  try {
    // Create a new object with only the properties we need
    return {
      id: message.id,
      text: message.text || '',
      date: message.date,
      peerId: message.peerId ? {
        channelId: message.peerId.channelId,
        userId: message.peerId.userId
      } : null,
      chatId: message.chatId,
      fromId: message.fromId,
      media: message.media ? {
        // Include minimal info about media to avoid circular refs
        type: message.media.constructor?.name || 'Unknown',
        photo: message.media.photo ? {
          id: message.media.photo.id,
          accessHash: message.media.photo.accessHash,
          sizes: Array.isArray(message.media.photo.sizes) ? 
            message.media.photo.sizes.map(s => ({
              type: s.type,
              w: s.w,
              h: s.h
            })) : []
        } : null,
        document: message.media.document ? {
          id: message.media.document.id,
          mimeType: message.media.document.mimeType,
          size: message.media.document.size
        } : null
      } : null,
      replyTo: message.replyTo ? {
        replyToMsgId: message.replyTo.replyToMsgId
      } : null
    };
  } catch (error) {
    logger.error(`Error extracting message data: ${error.message}`, {
      source: 'message-listener',
      messageId: message.id,
      stack: error.stack
    });
    
    // Fallback to basic info
    return {
      id: message.id,
      text: typeof message.text === 'string' ? message.text : '[complex content]',
      date: message.date
    };
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
          // First extract message data to avoid circular references
          const extractedMessage = extractMessageData(message);
          
          // Queue the message for processing
          await queueMessageForProcessing({
            type: 'new',
            channelId,
            message: extractedMessage,
            client,
            accountId: account._id.toString()
          });
          processedCount++;
        }
      } catch (error) {
        logger.error(`Error processing message ${message.id} from history: ${error.message}`, {
          channelId,
          source: 'message-listener',
          stack: error.stack
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

// Make sure messageListener is properly defined
const messageListener = {
  processNewMessage,
  processDeletedMessage,
  fetchMessageHistory,
  queueMessageForProcessing,
  processMessageQueue,
  RATE_LIMIT,
  messageQueue
};

// Export functions and variables individually AND as an object
module.exports = {
  processNewMessage,
  processDeletedMessage,
  fetchMessageHistory,
  queueMessageForProcessing,
  RATE_LIMIT,
  messageQueue,
  messageListener   // Add this to make the entire object available
};

// Also assign to module.exports directly for better compatibility
Object.assign(module.exports, messageListener); 