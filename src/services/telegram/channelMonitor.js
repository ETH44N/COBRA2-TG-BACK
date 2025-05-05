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
    // Check if there's already an active listener for this channel
    const listenerKey = channel._id.toString();
    if (activeListeners.has(listenerKey)) {
      logger.warn(`Channel ${channel.channel_id} already has an active listener, removing old one first`, {
        source: 'channel-monitor'
      });
      
      // Remove old listener to prevent duplicates
      const { client, eventHandler } = activeListeners.get(listenerKey);
      client.removeEventHandler(eventHandler);
      activeListeners.delete(listenerKey);
    }
    
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
          // Make sure we're comparing strings with strings
          const dbChannel = await Channel.findOne({ numeric_id: messageChannelId.toString() });
          
          if (dbChannel) {
            logger.debug(`Received message event from channel ${dbChannel.channel_id} (numeric ID: ${messageChannelId})`, {
              source: 'channel-monitor'
            });
            
            // Process message as usual...
            if (event.message.deleted) {
              await processDeletedMessage(dbChannel._id, event.message.id);
            } else {
              await processNewMessage(dbChannel._id, event.message, client);
            }
          } else {
            // Try to match by other channel identifiers if numeric ID fails
            const altChannel = await Channel.findOne({ 
              $or: [
                { channel_id: messageChannelId.toString() },
                { username: messageChannelId.toString() }
              ]
            });
            
            if (altChannel) {
              // Update the numeric_id if we found the channel by other means
              logger.info(`Found channel by alternate ID, updating numeric_id to ${messageChannelId} for ${altChannel.channel_id}`, {
                source: 'channel-monitor'
              });
              
              await Channel.updateOne(
                { _id: altChannel._id },
                { numeric_id: messageChannelId.toString() }
              );
              
              // Process the message
              if (event.message.deleted) {
                await processDeletedMessage(altChannel._id, event.message.id);
              } else {
                await processNewMessage(altChannel._id, event.message, client);
              }
            } else {
              // Get all channels we're monitoring to determine if this is excessive logging
              const monitoredChannelIds = await Channel.find(
                { is_active: true },
                { numeric_id: 1 }
              ).lean();
              
              // Only log this warning once per channel ID per session
              // to avoid excessive logging
              const cacheKey = `unrecognized_channel_${messageChannelId}`;
              if (!global._unrecognizedChannelCache) {
                global._unrecognizedChannelCache = new Set();
              }
              
              if (!global._unrecognizedChannelCache.has(cacheKey)) {
                global._unrecognizedChannelCache.add(cacheKey);
                
                // Extract more information about the entity type and message
                const peerInfo = {
                  isUser: !!event.message.peerId?.userId,
                  isChannel: !!event.message.peerId?.channelId,
                  isChat: !!event.message.peerId?.chatId,
                  entityType: event.message.peerId?.className || 'Unknown'
                };
                
                // Extract safe message info (avoid logging full message content)
                const messageInfo = {
                  id: event.message.id,
                  hasText: !!event.message.text,
                  textLength: event.message.text?.length || 0,
                  firstWords: event.message.text ? event.message.text.split(' ').slice(0, 3).join(' ') + '...' : '',
                  fromId: event.message.fromId?.toString(),
                  date: event.message.date,
                  isForwarded: !!event.message.fwdFrom,
                  hasMedia: !!event.message.media,
                  mediaType: event.message.media?.className || 'None'
                };
                
                logger.warn(`Received message from unrecognized ID: ${messageChannelId}`, {
                  source: 'channel-monitor',
                  context: {
                    peer_info: peerInfo,
                    message_info: messageInfo,
                    total_monitored_channels: monitoredChannelIds.length,
                    channel_id: messageChannelId
                  }
                });
              }
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
    activeListeners.set(listenerKey, {
      client,
      eventHandler,
      accountId: account._id.toString(),
      channelId: channel.channel_id,
      startedAt: new Date()
    });
    
    logger.info(`Started listening to channel ${channel.channel_id} with account ${account.phone_number}`, {
      source: 'channel-monitor'
    });
    
    // Update channel last_checked
    await Channel.findByIdAndUpdate(channel._id, {
      last_checked: new Date(),
      is_active: true,  // Mark as active since we're now listening
      last_error: null,  // Clear any previous errors
      last_error_at: null
    });
  } catch (error) {
    logger.error(`Error starting listener for channel ${channel.channel_id}: ${error.message}`, {
      source: 'channel-monitor',
      context: { error: error.stack }
    });
    
    // Update channel status
    await Channel.findByIdAndUpdate(channel._id, {
      last_error: error.message,
      last_error_at: new Date()
    });
    
    throw error;
  }
};

/**
 * Get status of all monitored channels
 * @returns {Object} Channel monitoring statistics
 */
const getMonitoringStatus = async () => {
  try {
    // Get counts
    const totalChannels = await Channel.countDocuments({});
    const activeChannels = await Channel.countDocuments({ is_active: true });
    
    // Get all accounts
    const accounts = await Account.find({ status: 'active' });
    
    // Get assignments
    const assignments = await AccountChannelAssignment.find({})
      .populate('channel_id')
      .populate('account_id');
    
    // Count listeners
    const activeListenerCount = activeListeners.size;
    
    // Track channels with and without listeners
    const channelsWithoutListeners = [];
    const channelsNoNumericId = [];
    
    // Check each active channel
    const allActiveChannels = await Channel.find({ is_active: true });
    
    for (const channel of allActiveChannels) {
      const listenerKey = channel._id.toString();
      if (!activeListeners.has(listenerKey)) {
        channelsWithoutListeners.push({
          id: channel._id,
          channel_id: channel.channel_id,
          name: channel.name
        });
      }
      
      if (!channel.numeric_id) {
        channelsNoNumericId.push({
          id: channel._id,
          channel_id: channel.channel_id,
          name: channel.name
        });
      }
    }
    
    // Get account distribution
    const accountStats = accounts.map(account => {
      const assignedChannels = assignments.filter(
        a => a.account_id._id.toString() === account._id.toString()
      );
      
      // Count active listeners for this account
      const listenersForAccount = Array.from(activeListeners.values())
        .filter(listener => listener.accountId === account._id.toString());
      
      return {
        phone_number: account.phone_number,
        assigned_channel_count: assignedChannels.length,
        active_listener_count: listenersForAccount.length
      };
    });
    
    return {
      total_channels: totalChannels,
      active_channels: activeChannels,
      monitored_channels: activeListenerCount,
      channels_without_listeners: channelsWithoutListeners,
      channels_missing_numeric_id: channelsNoNumericId,
      account_stats: accountStats
    };
  } catch (error) {
    logger.error(`Error getting monitoring status: ${error.message}`, {
      source: 'channel-monitor',
      context: { error: error.stack }
    });
    throw error;
  }
};

/**
 * Fix monitoring for channels that should be active but aren't being monitored
 */
const fixChannelMonitoring = async () => {
  try {
    // Get all active channels
    const activeChannels = await Channel.find({ is_active: true });
    
    logger.info(`Checking monitoring status for ${activeChannels.length} active channels`, {
      source: 'channel-monitor'
    });
    
    let fixedCount = 0;
    
    // Check each active channel
    for (const channel of activeChannels) {
      const listenerKey = channel._id.toString();
      
      // If no active listener, restart it
      if (!activeListeners.has(listenerKey)) {
        logger.warn(`Channel ${channel.channel_id} is active but has no listener, restarting`, {
          source: 'channel-monitor'
        });
        
        // Get assignment
        const assignment = await AccountChannelAssignment.findOne({
          channel_id: channel._id
        }).populate('account_id');
        
        if (!assignment) {
          logger.warn(`Channel ${channel.channel_id} has no account assignment, reassigning`, {
            source: 'channel-monitor'
          });
          
          // Reassign to a new account
          await reassignChannel(channel);
          fixedCount++;
          continue;
        }
        
        if (assignment.account_id.status !== 'active') {
          logger.warn(`Channel ${channel.channel_id} is assigned to inactive account ${assignment.account_id.phone_number}, reassigning`, {
            source: 'channel-monitor'
          });
          
          // Reassign to a new account
          await reassignChannel(channel);
          fixedCount++;
          continue;
        }
        
        // Restart listener with existing assignment
        try {
          await startListening(channel, assignment.account_id);
          fixedCount++;
        } catch (error) {
          logger.error(`Failed to restart listener for channel ${channel.channel_id}: ${error.message}`, {
            source: 'channel-monitor',
            context: { error: error.stack }
          });
        }
      }
    }
    
    logger.info(`Fixed monitoring for ${fixedCount} channels`, {
      source: 'channel-monitor'
    });
    
    return { fixed_count: fixedCount };
  } catch (error) {
    logger.error(`Error fixing channel monitoring: ${error.message}`, {
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
  startListening,
  getMonitoringStatus,
  fixChannelMonitoring
}; 