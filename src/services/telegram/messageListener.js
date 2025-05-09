const Message = require('../../models/Message');
const Channel = require('../../models/Channel');
const { sendWebhookNotification } = require('../webhook/webhookService');
const logger = require('../../utils/logger');
const config = require('../../config/telegram');

/**
 * Process a new message from a channel
 * @param {string} channelId - Channel ID (database ID)
 * @param {Object} message - Telegram message object
 * @param {Object} client - Telegram client
 */
const processNewMessage = async (channelId, message, client) => {
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
    
    // Check if message already exists - do this before any processing to avoid duplicate logs
    const existingMessage = await Message.findOne({ 
      channel_id: channelId, 
      message_id: message.id 
    });
    
    if (existingMessage) {
      logger.debug(`Message ${message.id} already exists in channel ${channel.channel_id}, skipping processing`, {
        source: 'message-listener'
      });
      return existingMessage;
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
        messageData.text = messageData.text || '[Photo]'; // Add indicator for non-text content
      } else if (message.media.document) {
        messageData.media_type = 'document';
        messageData.text = messageData.text || '[Document]'; // Add indicator for non-text content
      } else if (message.media.video) {
        messageData.media_type = 'video';
        messageData.text = messageData.text || '[Video]'; // Add indicator for non-text content
      } else if (message.media.audio) {
        messageData.media_type = 'audio';
        messageData.text = messageData.text || '[Audio]'; // Add indicator for non-text content
      } else if (message.media.gif || message.media.animation) {
        messageData.media_type = 'animation';
        messageData.text = messageData.text || '[GIF/Animation]'; // Add indicator for non-text content
      } else {
        messageData.media_type = 'other';
        messageData.text = messageData.text || '[Media]'; // Add indicator for non-text content
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
    } else {
      messageData.media_type = 'none';
    }
    
    // Save to database - use create to avoid double-logging
    const savedMessage = await Message.create(messageData);
    
    // Log only once per message
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
    // Check if it's a duplicate key error (message already exists)
    if (error.code === 11000) {
      logger.debug(`Duplicate message ${message.id} in channel ${channelId} - already saved`, {
        source: 'message-listener'
      });
      return null;
    }
    
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
 */
const processDeletedMessage = async (channelId, messageId) => {
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
    
    if (!channel.numeric_id) {
      logger.warn(`Channel ${channel.channel_id} has no numeric_id, cannot fetch history without resolving username`, {
        source: 'message-listener'
      });
      throw new Error(`Channel ${channel.channel_id} missing numeric_id`);
    }
    
    // Use the stored numeric ID instead of resolving the username again
    const channelId = BigInt(channel.numeric_id);
    
    // Get message history using the numeric ID
    const messages = await client.getMessages(channelId, {
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
        
        await processNewMessage(channel._id, message, client);
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
      count: processedCount
    };
  } catch (error) {
    // Check for flood wait errors and log them specially
    if (error.message.includes('A wait of') && error.message.includes('required')) {
      const waitTimeMatch = error.message.match(/A wait of (\d+) seconds is required/);
      const waitTime = waitTimeMatch ? waitTimeMatch[1] : 'unknown';
      
      logger.warn(`FloodWait error when fetching messages for ${channel.channel_id}: Need to wait ${waitTime} seconds`, {
        source: 'message-listener',
        context: { 
          channel_id: channel.channel_id,
          account: account.phone_number,
          waitTime
        }
      });
    }
    
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
  fetchMessageHistory
}; 