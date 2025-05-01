const Channel = require('../../models/Channel');
const AccountChannelAssignment = require('../../models/AccountChannelAssignment');
const Account = require('../../models/Account');
const { getClient } = require('./client');
const { getLeastLoadedAccount, updateAccountChannelCount } = require('./accountManager');
const logger = require('../../utils/logger');
const { processNewMessage, processDeletedMessage, queueMessageForProcessing, fetchMessageHistory, extractMessageData } = require('./messageListener');
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
    logger.info(`Starting account listener for ${account.phone_number || account._id} monitoring ${channels.length} channels`, {
      source: 'channel-monitor'
    });
    
    // Get or create a client for this account
    const client = await getClient(account);
    if (!client) {
      logger.error(`Could not get client for account ${account._id}`, {
        source: 'channel-monitor'
      });
      return false;
    }
    
    // Since we're having issues with event handlers, use polling instead
    await startPollingForMessages(account, channels, client);
    
    // For backwards compatibility, we'll still try to set up the event handlers
    // but we won't rely on them for message detection
    try {
      const telegramChannelIds = [];
      const channelIdsMap = {};
      const channelEntities = [];
      
      for (const channel of channels) {
        try {
          const entity = await getChannelEntity(channel.channel_id, client);
          if (entity) {
            channelEntities.push(entity);
            telegramChannelIds.push(entity.id);
            channelIdsMap[entity.id.toString()] = channel._id.toString();
          }
        } catch (error) {
          logger.warn(`Could not get entity for channel ${channel.channel_id}: ${error.message}`, {
            source: 'channel-monitor'
          });
        }
      }
      
      // Rest of your existing event handler code...
      // ... (keep your existing event handler implementation)
      
    } catch (eventSetupError) {
      logger.warn(`Failed to set up event handlers, but polling will still work: ${eventSetupError.message}`, {
        source: 'channel-monitor',
        stack: eventSetupError.stack
      });
    }
    
    logger.info(`Started monitoring ${channels.length} channels with account ${account.phone_number || account._id}`, {
      source: 'channel-monitor'
    });
    
    return true;
  } catch (error) {
    logger.error(`Failed to start account listener: ${error.message}`, {
      source: 'channel-monitor',
      stack: error.stack,
      accountId: account._id.toString()
    });
    return false;
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

// Add this polling function after the startAccountListener function
const startPollingForMessages = async (account, channels, client) => {
  try {
    logger.info(`Starting message polling for account ${account.phone_number || account._id} monitoring ${channels.length} channels`, {
      source: 'channel-monitor'
    });
    
    // Create a map of channel IDs for quick lookup
    const channelDbMap = {};
    
    // Get all channel entities first and store them
    const channelEntities = [];
    const telegramChannelIds = [];
    const channelIdsMap = {};
    
    for (const channel of channels) {
      channelDbMap[channel._id.toString()] = channel;
      
      try {
        const entity = await getChannelEntity(channel.channel_id, client);
        if (entity) {
          channelEntities.push(entity);
          const telegramId = entity.id.toString();
          telegramChannelIds.push(entity.id);
          channelIdsMap[telegramId] = channel._id.toString();
          
          logger.debug(`Got entity for channel ${entity.title || entity.username || entity.id}`, {
            source: 'channel-monitor'
          });
        }
      } catch (error) {
        logger.warn(`Could not get entity for channel ${channel.channel_id}: ${error.message}`, {
          source: 'channel-monitor'
        });
      }
    }
    
    // Start a polling interval to check for new messages
    const pollInterval = setInterval(async () => {
      try {
        for (const [index, entity] of channelEntities.entries()) {
          // Check every 3rd channel each time to spread the load
          if (index % 3 !== pollCounter % 3) continue;
          
          try {
            const telegramChannelId = entity.id.toString();
            const channelDbId = channelIdsMap[telegramChannelId];
            const channel = channelDbMap[channelDbId];
            
            if (channelDbId && channel) {
              logger.debug(`Polling for new messages in ${entity.title || entity.username || entity.id}`, {
                source: 'channel-poller',
                accountId: account._id.toString(),
                channelId: channelDbId
              });
              
              // Get last 5 messages from channel
              await fetchMessageHistory(channelDbId, account, client, 5);
              
              // Update the channel's last check time
              await Channel.findByIdAndUpdate(channelDbId, {
                last_poll_check: new Date()
              });
            }
          } catch (channelError) {
            logger.error(`Error polling channel ${entity.id}: ${channelError.message}`, {
              source: 'channel-poller',
              stack: channelError.stack
            });
          }
          
          // Small delay between channel checks to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        logger.error(`Error in polling loop: ${error.message}`, {
          source: 'channel-poller',
          stack: error.stack,
          accountId: account._id.toString()
        });
      }
    }, 20000); // Poll every 20 seconds
    
    // Initialize the poll counter for distributing load
    let pollCounter = 0;
    
    // Increment the poll counter every interval
    const counterInterval = setInterval(() => {
      pollCounter = (pollCounter + 1) % 3;
    }, 20000);
    
    // Keep track of intervals for cleanup
    if (!global.pollingIntervals) {
      global.pollingIntervals = {};
    }
    
    global.pollingIntervals[account._id.toString()] = {
      pollInterval,
      counterInterval
    };
    
    // Also run an immediate first check
    for (const entity of channelEntities) {
      try {
        const telegramChannelId = entity.id.toString();
        const channelDbId = channelIdsMap[telegramChannelId];
        
        if (channelDbId) {
          // Get last 10 messages from each channel initially
          await fetchMessageHistory(channelDbId, account, client, 10);
        }
      } catch (error) {
        logger.error(`Error in initial message check: ${error.message}`, {
          source: 'channel-poller',
          stack: error.stack
        });
      }
      
      // Small delay between checks
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return true;
  } catch (error) {
    logger.error(`Failed to start polling: ${error.message}`, {
      source: 'channel-poller',
      stack: error.stack,
      accountId: account._id.toString()
    });
    return false;
  }
};

// Create a channelMonitor object for easier importing
const channelMonitor = {
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

// Export both individual functions and as an object
module.exports = {
  addChannel,
  reassignChannel,
  initializeChannelMonitoring,
  joinChannel,
  startListening,
  startAccountListener,
  getChannelEntity,
  activeAccountListeners,
  channelEntityCache,
  channelMonitor  // Add the entire object
};

// Also assign to module.exports directly for better compatibility
Object.assign(module.exports, channelMonitor); 