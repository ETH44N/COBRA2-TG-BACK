const Channel = require('../../models/Channel');
const AccountChannelAssignment = require('../../models/AccountChannelAssignment');
const Account = require('../../models/Account');
const { getClient } = require('./client');
const { getLeastLoadedAccount, updateAccountChannelCount } = require('./accountManager');
const logger = require('../../utils/logger');
const { processNewMessage, processDeletedMessage } = require('./messageListener');
const { NewMessage } = require('telegram/events');
const { getBestAccountForNewChannel } = require('./accountManager');

// Store active channel listeners
const activeListeners = new Map();

// Add a cache for channel entities to avoid resolving usernames repeatedly
const channelEntityCache = new Map();

/**
 * Get a channel entity, using cache if available
 * @param {string} channelId - Channel ID or username
 * @param {Object} client - Telegram client
 * @returns {Promise<Object>} - Channel entity
 */
const getChannelEntity = async (channelId, client) => {
  // Check if we have a numeric ID in the input
  const isNumeric = /^\d+$/.test(channelId);
  
  // If numeric, we can use it directly and cache the result
  if (isNumeric) {
    if (!channelEntityCache.has(channelId)) {
      try {
        const entity = await client.getEntity(BigInt(channelId));
        channelEntityCache.set(channelId, entity);
        logger.debug(`Cached entity for numeric channel ID: ${channelId}`, {
          source: 'channel-monitor'
        });
      } catch (error) {
        logger.error(`Error getting entity for numeric channel ID ${channelId}: ${error.message}`, {
          source: 'channel-monitor',
          context: { error: error.stack }
        });
        throw error;
      }
    }
    return channelEntityCache.get(channelId);
  }
  
  // For non-numeric IDs (usernames, etc.), we need to resolve and then cache
  if (!channelEntityCache.has(channelId)) {
    try {
      const entity = await client.getEntity(channelId);
      // Cache with both the original ID and the numeric ID
      channelEntityCache.set(channelId, entity);
      if (entity.id) {
        channelEntityCache.set(entity.id.toString(), entity);
      }
      logger.debug(`Cached entity for channel: ${channelId}`, {
        source: 'channel-monitor'
      });
    } catch (error) {
      logger.error(`Error getting entity for channel ${channelId}: ${error.message}`, {
        source: 'channel-monitor',
        context: { error: error.stack }
      });
      throw error;
    }
  }
  
  return channelEntityCache.get(channelId);
};

/**
 * Initialize channel monitoring
 * Only starts monitoring channels that have been assigned to accounts
 */
const initializeChannelMonitoring = async () => {
  try {
    // Get all channel assignments
    const assignments = await AccountChannelAssignment.find({})
      .populate('channel_id')
      .populate('account_id');
    
    if (assignments.length === 0) {
      logger.info('No channel assignments found, skipping channel monitoring initialization', {
        source: 'channel-monitor'
      });
      return;
    }
    
    logger.info(`Initializing monitoring for ${assignments.length} channels`, {
      source: 'channel-monitor'
    });
    
    // Start monitoring each channel
    for (const assignment of assignments) {
      try {
        if (assignment.account_id.status !== 'active') {
          logger.warn(`Skipping channel ${assignment.channel_id.channel_id} as assigned account ${assignment.account_id.phone_number} is not active`, {
            source: 'channel-monitor'
          });
          continue;
        }
        
        await startListening(assignment.channel_id, assignment.account_id);
        
        logger.info(`Started monitoring channel ${assignment.channel_id.channel_id} with account ${assignment.account_id.phone_number}`, {
          source: 'channel-monitor'
        });
      } catch (error) {
        logger.error(`Failed to start monitoring channel ${assignment.channel_id.channel_id}: ${error.message}`, {
          source: 'channel-monitor',
          context: { error: error.stack }
        });
      }
    }
  } catch (error) {
    logger.error(`Error initializing channel monitoring: ${error.message}`, {
      source: 'channel-monitor',
      context: { error: error.stack }
    });
  }
};

/**
 * Add a new channel to monitor
 * @param {string} channelId - Channel ID or username
 * @returns {Promise<Object>} - Channel document
 */
const addChannel = async (channelId) => {
  try {
    // Check if channel already exists
    let channel = await Channel.findOne({ channel_id: channelId });
    
    if (channel) {
      logger.info(`Channel ${channelId} already exists`, {
        source: 'channel-monitor'
      });
      
      // Check if the channel is already assigned to an account
      const existingAssignment = await AccountChannelAssignment.findOne({
        channel_id: channel._id
      }).populate('account_id');
      
      // If already assigned and active, just return the channel
      if (existingAssignment && channel.is_active) {
        logger.info(`Channel ${channelId} is already being monitored by account ${existingAssignment.account_id.phone_number}`, {
          source: 'channel-monitor'
        });
        return channel;
      }
      
      // If channel exists but is not active or not assigned, we need to assign and activate it
      logger.info(`Channel ${channelId} exists but is not active or not assigned. Activating...`, {
        source: 'channel-monitor'
      });
      
      // Get best account for the channel
      const account = await getBestAccountForNewChannel();
      
      // If there's an existing assignment but with a different account, remove it
      if (existingAssignment && existingAssignment.account_id._id.toString() !== account._id.toString()) {
        await AccountChannelAssignment.findByIdAndDelete(existingAssignment._id);
        await updateAccountChannelCount(existingAssignment.account_id._id, -1);
      }
      
      // Join channel and update details if not active
      if (!channel.is_active) {
        await joinChannel(channel, account);
      }
      
      // Create new assignment if needed
      if (!existingAssignment || existingAssignment.account_id._id.toString() !== account._id.toString()) {
        await AccountChannelAssignment.create({
          account_id: account._id,
          channel_id: channel._id,
          assigned_at: new Date()
        });
        
        // Update account channel count
        await updateAccountChannelCount(account._id, 1);
      }
      
      // Start listening for messages
      await startListening(channel, account);
      
      logger.info(`Started monitoring existing channel ${channelId} with account ${account.phone_number}`, {
        source: 'channel-monitor'
      });
      
      return channel;
    }
    
    // If channel doesn't exist, create it
    // Get best account for new channel
    const account = await getBestAccountForNewChannel();
    
    // Create channel with a temporary name if not provided
    channel = await Channel.findOneAndUpdate(
      { channel_id: channelId },
      { 
        channel_id: channelId,
        name: channelId, // Use channel ID as temporary name
        is_active: false,
        date_joined: new Date()
      },
      { upsert: true, new: true }
    );
    
    // Join channel and update details
    await joinChannel(channel, account);
    
    // Create assignment
    await AccountChannelAssignment.create({
      account_id: account._id,
      channel_id: channel._id,
      assigned_at: new Date()
    });
    
    // Update account channel count
    await updateAccountChannelCount(account._id, 1);
    
    // Start listening for messages
    await startListening(channel, account);
    
    logger.info(`Added new channel ${channelId} and assigned to account ${account.phone_number}`, {
      source: 'channel-monitor'
    });
    
    return channel;
  } catch (error) {
    logger.error(`Error adding channel ${channelId}: ${error.message}`, {
      source: 'channel-monitor',
      context: { error: error.stack }
    });
    throw error;
  }
};

/**
 * Reassign a channel to a different account
 * @param {Object} channel - Channel document
 * @returns {Promise<Object>} - Updated assignment
 */
const reassignChannel = async (channel) => {
  try {
    // Get current assignment
    const currentAssignment = await AccountChannelAssignment.findOne({
      channel_id: channel._id
    }).populate('account_id');
    
    if (currentAssignment) {
      // Stop current listener
      const listenerKey = channel._id.toString();
      if (activeListeners.has(listenerKey)) {
        const { client, eventHandler } = activeListeners.get(listenerKey);
        client.removeEventHandler(eventHandler);
        activeListeners.delete(listenerKey);
        
        logger.info(`Stopped listening to channel ${channel.channel_id} with account ${currentAssignment.account_id.phone_number}`, {
          source: 'channel-monitor'
        });
      }
      
      // Update account channel count
      await updateAccountChannelCount(currentAssignment.account_id._id, -1);
    }
    
    // Get new account
    const newAccount = await getLeastLoadedAccount();
    
    // Create or update assignment
    const assignment = await AccountChannelAssignment.findOneAndUpdate(
      { channel_id: channel._id },
      {
        account_id: newAccount._id,
        assigned_at: new Date()
      },
      { upsert: true, new: true }
    );
    
    // Update account channel count
    await updateAccountChannelCount(newAccount._id, 1);
    
    // Start listening with new account
    await startListening(channel, newAccount);
    
    logger.info(`Reassigned channel ${channel.channel_id} to account ${newAccount.phone_number}`, {
      source: 'channel-monitor'
    });
    
    return assignment;
  } catch (error) {
    logger.error(`Error reassigning channel ${channel.channel_id}: ${error.message}`, {
      source: 'channel-monitor',
      context: { error: error.stack }
    });
    throw error;
  }
};

/**
 * Join a channel and update its details
 * @param {Object} channel - Channel document
 * @param {Object} account - Account document
 * @returns {Promise<Object>} - Updated channel
 */
const joinChannel = async (channel, account) => {
  try {
    // Get client for account
    const client = await getClient(account);
    
    // Use the cached getEntity function to avoid rate limits
    const entity = await getChannelEntity(channel.channel_id, client);
    
    // Get the numeric ID - this is critical to avoid future resolveUsername calls
    const numericId = entity.id?.toString();
    
    // Update channel details
    const updates = {
      is_active: true,
      name: entity.title || channel.name || channel.channel_id,
      username: entity.username || null,
      date_joined: new Date(),
      numeric_id: numericId // Store the numeric ID to avoid future resolutions
    };
    
    // Add description and member count if available
    if (entity.about) updates.description = entity.about;
    if (entity.participantsCount) updates.member_count = entity.participantsCount;
    
    // Update channel
    const updatedChannel = await Channel.findByIdAndUpdate(
      channel._id,
      updates,
      { new: true }
    );
    
    logger.info(`Joined channel ${channel.channel_id} with account ${account.phone_number}, numeric_id: ${numericId}`, {
      source: 'channel-monitor'
    });
    
    return updatedChannel;
  } catch (error) {
    // Check if it's a FloodWait error
    if (error.message.includes('A wait of') && error.message.includes('required')) {
      const waitTimeMatch = error.message.match(/A wait of (\d+) seconds is required/);
      const waitTime = waitTimeMatch ? waitTimeMatch[1] : 'unknown';
      
      logger.warn(`FloodWait error when joining channel ${channel.channel_id}: Need to wait ${waitTime} seconds`, {
        source: 'channel-monitor',
        context: { 
          channel_id: channel.channel_id,
          account: account.phone_number,
          waitTime
        }
      });
    }
    
    logger.error(`Error joining channel ${channel.channel_id}: ${error.message}`, {
      source: 'channel-monitor',
      context: { error: error.stack }
    });
    
    // Update channel status
    await Channel.findByIdAndUpdate(channel._id, {
      is_active: false,
      last_error: error.message,
      last_error_at: new Date()
    });
    
    throw error;
  }
};

/**
 * Start listening for messages in a channel
 * @param {Object} channel - Channel document
 * @param {Object} account - Account document
 */
const startListening = async (channel, account) => {
  try {
    // Get client for account
    const client = await getClient(account);
    
    // Create event handler for new messages
    const eventHandler = async (event) => {
      try {
        if (event.message) {
          // Get the message's channel ID directly from the event
          const messageChannelId = event.message.peerId?.channelId?.toString() || 
                                  event.message.chatId?.toString();
          
          if (!messageChannelId) {
            logger.warn('Message without channel ID received', { source: 'channel-monitor' });
            return;
          }
          
          // Find the channel in our database by numeric_id instead of doing getEntity
          const dbChannel = await Channel.findOne({ numeric_id: messageChannelId });
          
          if (dbChannel) {
            logger.debug(`Received message event from channel ${dbChannel.channel_id}`, {
              source: 'channel-monitor'
            });
            
            // Process message as usual...
            if (event.message.deleted) {
              await processDeletedMessage(dbChannel._id, event.message.id);
            } else {
              await processNewMessage(dbChannel._id, event.message, client);
            }
          }
        }
      } catch (error) {
        logger.error(`Error processing message event: ${error.message}`, {
          source: 'channel-monitor',
          context: { error: error.stack }
        });
      }
    };
    
    // Add event handler
    client.addEventHandler(eventHandler, new NewMessage({}));
    
    // Store listener
    activeListeners.set(channel._id.toString(), {
      client,
      eventHandler,
      accountId: account._id.toString()
    });
    
    logger.info(`Started listening to channel ${channel.channel_id} with account ${account.phone_number}`, {
      source: 'channel-monitor'
    });
    
    // Update channel last_checked
    await Channel.findByIdAndUpdate(channel._id, {
      last_checked: new Date()
    });
  } catch (error) {
    logger.error(`Error starting listener for channel ${channel.channel_id}: ${error.message}`, {
      source: 'channel-monitor',
      context: { error: error.stack }
    });
    throw error;
  }
};

module.exports = {
  addChannel,
  reassignChannel,
  initializeChannelMonitoring,
  joinChannel,
  startListening
}; 