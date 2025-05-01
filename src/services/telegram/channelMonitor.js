const Channel = require('../../models/Channel');
const AccountChannelAssignment = require('../../models/AccountChannelAssignment');
const Account = require('../../models/Account');
const { getClient } = require('./client');
const { getLeastLoadedAccount, updateAccountChannelCount } = require('./accountManager');
const logger = require('../../utils/logger');
const { processNewMessage, processDeletedMessage, queueMessageForProcessing } = require('./messageListener');
const { NewMessage } = require('telegram/events');
const { getBestAccountForNewChannel } = require('./accountManager');

// Store active account listeners
const activeAccountListeners = new Map();
// Store active channel listeners (will be deprecated)
const activeListeners = new Map();
// Store mapping of account ID to array of channel IDs they're monitoring
const accountChannelMap = new Map();
// Cache for channel entities to avoid repeated getEntity calls
const channelEntityCache = new Map();

/**
 * Initialize channel monitoring
 * Only starts monitoring channels that have been assigned to accounts
 */
const initializeChannelMonitoring = async () => {
  try {
    // Clear any existing state
    activeAccountListeners.clear();
    accountChannelMap.clear();
    channelEntityCache.clear();
    
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
    
    // Group assignments by account
    const accountAssignments = {};
    
    for (const assignment of assignments) {
      const accountId = assignment.account_id._id.toString();
      if (!accountAssignments[accountId]) {
        accountAssignments[accountId] = [];
      }
      
      accountAssignments[accountId].push(assignment);
    }
    
    // Start monitoring for each account
    for (const [accountId, accountAssignmentsList] of Object.entries(accountAssignments)) {
      const account = accountAssignmentsList[0].account_id;
      
      if (account.status !== 'active') {
        logger.warn(`Skipping account ${account.phone_number} as it is not active`, {
          source: 'channel-monitor'
        });
        continue;
      }
      
      // Set up the map of channels monitored by this account
      const channelIds = [];
      for (const assignment of accountAssignmentsList) {
        if (assignment.channel_id) {
          channelIds.push(assignment.channel_id._id.toString());
        }
      }
      
      accountChannelMap.set(accountId, channelIds);
      
      // Start a single listener for all channels assigned to this account
      try {
        await startAccountListener(account, accountAssignmentsList.map(a => a.channel_id));
        
        logger.info(`Started monitoring ${channelIds.length} channels with account ${account.phone_number}`, {
          source: 'channel-monitor'
        });
      } catch (error) {
        logger.error(`Failed to start account listener for ${account.phone_number}: ${error.message}`, {
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
        
        // Remove from the account's channel map if it exists
        if (accountChannelMap.has(existingAssignment.account_id._id.toString())) {
          const channelList = accountChannelMap.get(existingAssignment.account_id._id.toString());
          const filteredList = channelList.filter(id => id !== channel._id.toString());
          accountChannelMap.set(existingAssignment.account_id._id.toString(), filteredList);
        }
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
        
        // Add to the account's channel map
        if (!accountChannelMap.has(account._id.toString())) {
          accountChannelMap.set(account._id.toString(), []);
        }
        accountChannelMap.get(account._id.toString()).push(channel._id.toString());
      }
      
      // Update active account listener or start a new one
      if (activeAccountListeners.has(account._id.toString())) {
        // Get the channel entity and add to cache
        const client = activeAccountListeners.get(account._id.toString()).client;
        try {
          const entity = await client.getEntity(channel.channel_id);
          channelEntityCache.set(channel.channel_id, entity);
          
          // Add to listener's channel IDs
          const listener = activeAccountListeners.get(account._id.toString());
          if (!listener.channelIds.includes(channel._id.toString())) {
            listener.channelIds.push(channel._id.toString());
          }
          
          // Mark channel as active
          await Channel.findByIdAndUpdate(channel._id, {
            is_active: true,
            last_checked: new Date()
          });
        } catch (error) {
          logger.error(`Error updating active listener for channel ${channel.channel_id}: ${error.message}`, {
            source: 'channel-monitor',
            context: { error: error.stack }
          });
        }
      } else {
        // Start a new listener for this account
        const channels = await Channel.find({
          _id: { $in: accountChannelMap.get(account._id.toString()) || [] }
        });
        await startAccountListener(account, channels);
      }
      
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
    
    // Add to account channel map
    if (!accountChannelMap.has(account._id.toString())) {
      accountChannelMap.set(account._id.toString(), []);
    }
    accountChannelMap.get(account._id.toString()).push(channel._id.toString());
    
    // Update active listener or start a new one
    if (activeAccountListeners.has(account._id.toString())) {
      // Get the channel entity and add to cache
      const client = activeAccountListeners.get(account._id.toString()).client;
      try {
        const entity = await client.getEntity(channel.channel_id);
        channelEntityCache.set(channel.channel_id, entity);
        
        // Add to listener's channel IDs
        const listener = activeAccountListeners.get(account._id.toString());
        if (!listener.channelIds.includes(channel._id.toString())) {
          listener.channelIds.push(channel._id.toString());
        }
        
        // Mark channel as active
        await Channel.findByIdAndUpdate(channel._id, {
          is_active: true,
          last_checked: new Date()
        });
      } catch (error) {
        logger.error(`Error updating active listener for channel ${channel.channel_id}: ${error.message}`, {
          source: 'channel-monitor',
          context: { error: error.stack }
        });
      }
    } else {
      // Start a new listener for this account
      await startAccountListener(account, [channel]);
    }
    
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
      const oldAccountId = currentAssignment.account_id._id.toString();
      
      // Remove channel from the old account's map
      if (accountChannelMap.has(oldAccountId)) {
        const channelIds = accountChannelMap.get(oldAccountId);
        const updatedChannelIds = channelIds.filter(id => id !== channel._id.toString());
        accountChannelMap.set(oldAccountId, updatedChannelIds);
      }
      
      // Delete the assignment
      await AccountChannelAssignment.findByIdAndDelete(currentAssignment._id);
      
      // Update old account's channel count
      await updateAccountChannelCount(oldAccountId, -1);
    }
    
    // Get best account for reassignment
    const newAccount = await getLeastLoadedAccount();
    
    // Create new assignment
    const newAssignment = await AccountChannelAssignment.create({
      account_id: newAccount._id,
      channel_id: channel._id,
      assigned_at: new Date(),
      status: 'active'
    });
    
    // Add to account channel map
    if (!accountChannelMap.has(newAccount._id.toString())) {
      accountChannelMap.set(newAccount._id.toString(), []);
    }
    accountChannelMap.get(newAccount._id.toString()).push(channel._id.toString());
    
    // Update new account's channel count
    await updateAccountChannelCount(newAccount._id, 1);
    
    // Attempt to join channel with new account if not already joined
    try {
      await joinChannel(channel, newAccount);
    } catch (error) {
      logger.warn(`Channel ${channel.channel_id} join failed during reassignment: ${error.message}`, {
        source: 'channel-monitor'
      });
    }
    
    // Update active listener or start a new one for the new account
    if (activeAccountListeners.has(newAccount._id.toString())) {
      // Get the channel entity and add to cache
      const client = activeAccountListeners.get(newAccount._id.toString()).client;
      try {
        const entity = await client.getEntity(channel.channel_id);
        channelEntityCache.set(channel.channel_id, entity);
        
        // Add to listener's channel IDs
        const listener = activeAccountListeners.get(newAccount._id.toString());
        if (!listener.channelIds.includes(channel._id.toString())) {
          listener.channelIds.push(channel._id.toString());
        }
        
        logger.info(`Added channel ${channel.channel_id} to existing listener for account ${newAccount.phone_number}`, {
          source: 'channel-monitor'
        });
      } catch (error) {
        logger.error(`Error updating active listener during reassignment: ${error.message}`, {
          source: 'channel-monitor',
          context: { error: error.stack }
        });
      }
    } else {
      // Start a new listener for this account
      await startAccountListener(newAccount, [channel]);
    }
    
    logger.info(`Reassigned channel ${channel.channel_id} from account ${currentAssignment ? currentAssignment.account_id.phone_number : 'none'} to ${newAccount.phone_number}`, {
      source: 'channel-monitor'
    });
    
    // Mark channel as active
    await Channel.findByIdAndUpdate(channel._id, {
      is_active: true,
      last_checked: new Date()
    });
    
    return newAssignment;
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
    
    // Join channel
    const entity = await client.getEntity(channel.channel_id);
    
    // Update channel details
    const updates = {
      is_active: true,
      name: entity.title || channel.name || channel.channel_id,
      username: entity.username || null,
      date_joined: new Date()
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
    
    logger.info(`Joined channel ${channel.channel_id} with account ${account.phone_number}`, {
      source: 'channel-monitor'
    });
    
    return updatedChannel;
  } catch (error) {
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
          // Get the channel entity to compare IDs
          const channelEntity = await client.getEntity(channel.channel_id);
          
          // Check if message is from the monitored channel
          // Different ways to check depending on the message type
          let isFromMonitoredChannel = false;
          
          if (event.message.peerId && event.message.peerId.channelId) {
            const peerId = event.message.peerId.channelId.toString();
            const channelId = channelEntity.id.toString();
            isFromMonitoredChannel = (peerId === channelId);
          } else if (event.message.chatId) {
            const chatId = event.message.chatId.toString();
            const channelId = channelEntity.id.toString();
            isFromMonitoredChannel = (chatId === channelId);
          }
          
          if (isFromMonitoredChannel) {
            logger.debug(`Received message event from channel ${channel.channel_id}`, {
              source: 'channel-monitor'
            });
            
            // Check for deleted messages
            if (event.message.deleted) {
              logger.info(`Detected deleted message ${event.message.id} in channel ${channel.channel_id}`, {
                source: 'channel-monitor'
              });
              
              // Process deleted message
              await processDeletedMessage(channel._id, event.message.id);
            } else {
              // Skip messages without an ID
              if (!event.message.id) {
                logger.warn(`Skipping message without ID in channel ${channel.channel_id}`, {
                  source: 'channel-monitor'
                });
                return;
              }
              
              // Process new message
              await processNewMessage(channel._id, event.message, client);
            }
          }
        }
      } catch (error) {
        logger.error(`Error processing message event: ${error.message}`, {
          source: 'channel-monitor',
          context: { error: error.stack, channelId: channel.channel_id }
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

/**
 * Start listening for messages for all channels assigned to an account
 * @param {Object} account - Account document
 * @param {Array} channels - Array of channel documents
 */
const startAccountListener = async (account, channels) => {
  try {
    // Get client for account
    const client = await getClient(account);
    
    // Skip if already listening for this account
    if (activeAccountListeners.has(account._id.toString())) {
      logger.info(`Account ${account.phone_number} already has an active listener`, {
        source: 'channel-monitor'
      });
      return;
    }
    
    // Create channel ID map for quick lookups
    const channelIdsMap = {};
    const telegramChannelIds = [];
    
    for (const channel of channels) {
      if (channel && channel.channel_id) {
        // Cache channel entity
        try {
          const entity = await client.getEntity(channel.channel_id);
          channelEntityCache.set(channel.channel_id, entity);
          
          // Store the numeric/internal Telegram ID if available
          if (entity && entity.id) {
            channelIdsMap[entity.id.toString()] = channel._id.toString();
            telegramChannelIds.push(entity.id);
          }
        } catch (error) {
          logger.warn(`Could not get entity for channel ${channel.channel_id}: ${error.message}`, {
            source: 'channel-monitor'
          });
        }
      }
    }
    
    // Create event handler for new messages
    const newMessageHandler = async (event) => {
      try {
        logger.debug(`Received NewMessage event: ${JSON.stringify({
          className: event.className,
          chatId: event.chatId,
          senderId: event.senderId,
          hasMessage: !!event.message,
          messageId: event.message?.id
        })}`, { 
          accountId: account._id, 
          source: 'channel-monitor'
        });
        
        if (!event.message) return;
        
        // Get relevant IDs from the message event
        let peerId = null;
        
        if (event.message.peerId && event.message.peerId.channelId) {
          peerId = event.message.peerId.channelId.toString();
        } else if (event.message.chatId) {
          peerId = event.message.chatId.toString();
        } else if (event.chat && event.chat.id) {
          peerId = event.chat.id.toString();
        }
        
        // Skip if no valid peer ID
        if (!peerId) {
          logger.debug(`Skipping message with no peer ID`, {
            source: 'channel-monitor'
          });
          return;
        }
        
        // Check if this message is from one of our monitored channels
        const channelDbId = channelIdsMap[peerId];
        
        if (channelDbId) {
          logger.info(`Received NEW message event from monitored channel (peer ID: ${peerId}, message ID: ${event.message.id})`, {
            source: 'channel-monitor'
          });
          
          // Skip messages without an ID
          if (!event.message.id) {
            logger.warn(`Skipping message without ID`, {
              source: 'channel-monitor'
            });
            return;
          }
          
          // Process new message with rate limiting
          await queueMessageForProcessing({
            type: 'new',
            channelId: channelDbId,
            message: event.message,
            client,
            accountId: account._id.toString()
          });
        }
      } catch (error) {
        logger.error(`Error handling NewMessage event: ${error.message}`, {
          accountId: account._id,
          source: 'channel-monitor',
          stack: error.stack
        });
      }
    };
    
    // Create handler for raw updates (to catch deletions)
    const rawUpdateHandler = async (update) => {
      try {
        logger.debug(`Received Raw update: ${update?.className || 'unknown'}`, { 
          accountId: account._id,
          source: 'channel-monitor'
        });
        
        // Check for deleted messages
        if (update?.className === 'UpdateDeleteChannelMessages') {
          const channelId = update.channelId?.toString();
          if (!channelId) return;
          
          const channelDbId = channelIdsMap[channelId];
          if (!channelDbId) return;
          
          logger.info(`Detected DELETED messages in channel ${channelId}: ${JSON.stringify(update.messages)}`, {
            source: 'channel-monitor'
          });
          
          // Process each deleted message ID
          for (const messageId of update.messages) {
            await queueMessageForProcessing({
              type: 'deleted',
              channelId: channelDbId,
              messageId,
              accountId: account._id.toString()
            });
          }
        }
      } catch (error) {
        logger.error(`Error handling Raw update: ${error.message}`, {
          accountId: account._id,
          source: 'channel-monitor',
          stack: error.stack
        });
      }
    };
    
    // Register both event handlers
    const { NewMessage, Raw } = require('telegram/events');
    
    // Add event handler for new messages 
    client.addEventHandler(newMessageHandler, new NewMessage({
      chats: telegramChannelIds.length > 0 ? telegramChannelIds : null
    }));
    
    // Add raw event handler for catching message deletions
    client.addEventHandler(rawUpdateHandler, new Raw({}));
    
    // Store listener
    activeAccountListeners.set(account._id.toString(), {
      client,
      handlers: [newMessageHandler, rawUpdateHandler],
      channelIds: channels.map(c => c._id.toString())
    });
    
    logger.info(`Started account listener for ${account.phone_number} monitoring ${channels.length} channels`, {
      source: 'channel-monitor'
    });
    
    // Update account and channels
    await Account.findByIdAndUpdate(account._id, {
      last_active: new Date()
    });
    
    for (const channel of channels) {
      await Channel.findByIdAndUpdate(channel._id, {
        last_checked: new Date(),
        is_active: true
      });
    }
  } catch (error) {
    logger.error(`Error starting account listener: ${error.message}`, {
      source: 'channel-monitor',
      stack: error.stack
    });
    throw error;
  }
};

/**
 * Get cached channel entity or fetch it if not available
 * @param {string} channelId - Telegram channel ID
 * @param {Object} client - Telegram client
 * @returns {Promise<Object>} - Channel entity
 */
const getChannelEntity = async (channelId, client) => {
  // Check cache first
  if (channelEntityCache.has(channelId)) {
    return channelEntityCache.get(channelId);
  }
  
  // If not in cache, fetch it
  try {
    const entity = await client.getEntity(channelId);
    // Store in cache
    channelEntityCache.set(channelId, entity);
    return entity;
  } catch (error) {
    logger.error(`Error fetching channel entity for ${channelId}: ${error.message}`, {
      source: 'channel-monitor'
    });
    throw error;
  }
};

// Export module
module.exports = {
  addChannel,
  reassignChannel,
  initializeChannelMonitoring,
  joinChannel,
  startListening,
  startAccountListener,
  getChannelEntity,
  activeAccountListeners,
  channelEntityCache
};

// Also export the entire module as channelMonitor for direct access
module.exports.channelMonitor = module.exports; 