const express = require('express');
const { getChannelMessages, fetchHistory, getMessageById } = require('../controllers/messageController');
const Message = require('../models/Message');
const Channel = require('../models/Channel');
const Account = require('../models/Account');
const AccountChannelAssignment = require('../models/AccountChannelAssignment');
const logger = require('../utils/logger');
const { activeAccountListeners, channelEntityCache } = require('../services/telegram/channelMonitor');
const { RATE_LIMIT, messageQueue, messageListener } = require('../services/telegram/messageListener');

const router = express.Router();

// Get messages for a channel
router.get('/channel/:channelId', getChannelMessages);

// Fetch message history for a channel
router.post('/channel/:channelId/fetch-history', fetchHistory);

// Get a single message by ID
router.get('/:id', getMessageById);

/**
 * @route   GET /api/messages/stats
 * @desc    Get message statistics
 * @access  Public
 */
router.get('/stats', async (req, res) => {
  try {
    const totalMessages = await Message.countDocuments();
    const deletedMessages = await Message.countDocuments({ is_deleted: true });
    
    res.json({
      success: true,
      stats: {
        total: totalMessages,
        active: totalMessages - deletedMessages,
        deleted: deletedMessages
      }
    });
  } catch (error) {
    logger.error(`Error getting message stats: ${error.message}`, {
      source: 'api',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to get message statistics'
    });
  }
});

/**
 * @route   GET /api/messages/recent
 * @desc    Get recent messages
 * @access  Public
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const messages = await Message.find()
      .sort({ created_at: -1 })
      .limit(limit)
      .populate('channel_id')
      .lean();
    
    res.json({
      success: true,
      messages
    });
  } catch (error) {
    logger.error(`Error getting recent messages: ${error.message}`, {
      source: 'api',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to get recent messages'
    });
  }
});

/**
 * @route   GET /api/messages/diagnostics
 * @desc    Get diagnostic information about the message system
 * @access  Public
 */
router.get('/diagnostics', async (req, res) => {
  try {
    // Basic database stats
    const accountCount = await Account.countDocuments();
    const channelCount = await Channel.countDocuments();
    const messageCount = await Message.countDocuments();
    
    // Recent messages
    const recentMessages = await Message.find()
      .sort({ created_at: -1 })
      .limit(5)
      .lean();
    
    // Recent channels 
    const recentChannels = await Channel.find()
      .sort({ last_checked: -1 })
      .limit(5)
      .lean();
    
    // Database connection status
    const dbStatus = require('mongoose').connection.readyState === 1 ? 'connected' : 'disconnected';
    
    // Return diagnostic data
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: {
        status: dbStatus,
        stats: {
          accounts: accountCount,
          channels: channelCount,
          messages: messageCount
        }
      },
      recentData: {
        messages: recentMessages.map(msg => ({
          id: msg._id,
          channelId: msg.channel_id,
          messageId: msg.message_id,
          content: msg.content ? msg.content.substring(0, 50) + '...' : '[no content]',
          createdAt: msg.created_at
        })),
        channels: recentChannels.map(ch => ({
          id: ch._id,
          channelId: ch.channel_id,
          title: ch.title,
          isActive: ch.is_active,
          lastChecked: ch.last_checked
        }))
      },
      serverInfo: {
        nodeVersion: process.version,
        uptime: process.uptime()
      }
    });
  } catch (error) {
    logger.error(`Error getting diagnostics: ${error.message}`, {
      source: 'message-routes',
      stack: error.stack
    });
    
    res.status(500).json({
      status: 'error',
      message: `Diagnostics error: ${error.message}`
    });
  }
});

// Test endpoint to add a message manually for testing
router.post('/test-message', async (req, res) => {
  try {
    const { channelId, messageId, content } = req.body;
    
    if (!channelId || !messageId) {
      return res.status(400).json({
        success: false,
        message: 'Channel ID and message ID are required'
      });
    }
    
    // Get channel
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: `Channel with ID ${channelId} not found`
      });
    }
    
    // Create test message
    const testMessage = new Message({
      message_id: messageId,
      channel: channelId,
      content: content || 'Test message content',
      type: 'text',
      created_at: new Date(),
      is_active: true
    });
    
    await testMessage.save();
    
    logger.info(`Added test message ${messageId} for channel ${channel.channel_id}`, {
      source: 'message-routes'
    });
    
    return res.status(200).json({
      success: true,
      message: 'Test message added successfully',
      data: testMessage
    });
  } catch (error) {
    logger.error(`Error adding test message: ${error.message}`, {
      source: 'message-routes',
      stack: error.stack
    });
    
    return res.status(500).json({
      success: false,
      message: 'Error adding test message',
      error: error.message
    });
  }
});

// Get monitor status (active event handlers)
router.get('/monitor-status', async (req, res) => {
  try {
    // Import services with required variables - use try/catch for more resilient imports
    let activeAccountListeners, channelEntityCache, messageQueue, RATE_LIMIT;
    
    try {
      const channelMonitor = require('../services/telegram/channelMonitor');
      activeAccountListeners = channelMonitor.activeAccountListeners;
      channelEntityCache = channelMonitor.channelEntityCache;
      
      const messageListener = require('../services/telegram/messageListener');
      messageQueue = messageListener.messageQueue;
      RATE_LIMIT = messageListener.RATE_LIMIT;
    } catch (importError) {
      logger.error(`Error importing monitor dependencies: ${importError.message}`, {
        source: 'message-routes',
        stack: importError.stack
      });
    }
    
    // Count of active accounts in the database
    const activeAccounts = await Account.countDocuments({
      status: 'active', 
      isBanned: { $ne: true }
    });
    
    // Get recent messages count
    const recentMessages = await Message.countDocuments({
      created_at: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Last 30 minutes
    });
    
    // Information about each active listener
    const listenersInfo = [];
    
    // Only process listeners if available
    if (activeAccountListeners && activeAccountListeners.size > 0) {
      for (const [accountId, listener] of activeAccountListeners.entries()) {
        // Get the account information
        const account = await Account.findById(accountId);
        
        // Get channel information for this listener
        const channels = [];
        if (listener.channelIds && listener.channelIds.length > 0) {
          for (const channelId of listener.channelIds.slice(0, 3)) { // Only get up to 3 channels to avoid overload
            const channel = await Channel.findById(channelId);
            if (channel) {
              channels.push({
                id: channelId,
                channelId: channel.channel_id,
                title: channel.title,
                lastChecked: channel.last_checked
              });
            }
          }
        }
        
        // Add to list of listeners
        listenersInfo.push({
          accountId,
          phone: account ? account.phone_number : 'unknown',
          handlerCount: listener.handlers ? listener.handlers.length : 0,
          monitoredChannels: listener.channelIds ? listener.channelIds.length : 0,
          channels: channels,
          hasInterval: !!listener.messageCheckInterval,
          clientConnected: listener.client && listener.client.connected
        });
      }
    }
    
    // Return monitor status data
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      activeAccounts,
      activeListeners: {
        count: activeAccountListeners ? activeAccountListeners.size : 0,
        listeners: listenersInfo
      },
      messageQueue: {
        length: messageQueue ? messageQueue.queue.length : 0,
        isProcessing: messageQueue ? messageQueue.isProcessing : false,
        rateLimit: RATE_LIMIT || { accounts: {} }
      },
      stats: {
        recentMessages,
        entityCacheSize: channelEntityCache ? channelEntityCache.size : 0
      }
    });
  } catch (error) {
    logger.error(`Error getting monitor status: ${error.message}`, {
      source: 'message-routes',
      stack: error.stack
    });
    
    res.status(500).json({
      status: 'error',
      message: `Could not get monitor status: ${error.message}`
    });
  }
});

// Helper function to safely log message data without circular references
const safeLogMessage = (message) => {
  if (!message) return null;
  
  try {
    return {
      id: message.id,
      text: message.text ? (typeof message.text === 'string' ? message.text.substring(0, 100) : '[complex text]') : null,
      date: message.date,
      hasMedia: !!message.media,
      mediaType: message.media ? message.media.constructor?.name : null,
      chat: message.chat ? {
        id: message.chat.id,
        title: message.chat.title
      } : null
    };
  } catch (error) {
    logger.error(`Error creating safe message log: ${error.message}`);
    return { id: message.id, error: 'Failed to extract message data' };
  }
};

// Add a test endpoint to check Telegram event listening
router.get('/test-telegram-updates', async (req, res) => {
  try {
    const channelId = req.query.channelId;
    const accountId = req.query.accountId;
    
    if (!channelId || !accountId) {
      return res.status(400).json({
        success: false,
        message: 'Both channelId and accountId parameters are required'
      });
    }
    
    // Get account
    const account = await Account.findById(accountId);
    if (!account) {
      return res.status(404).json({
        success: false,
        message: `Account with ID ${accountId} not found`
      });
    }
    
    // Get channel
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: `Channel with ID ${channelId} not found`
      });
    }
    
    // Get Telegram client
    const telegramClient = require('../services/telegram/telegramClient');
    const client = await telegramClient.getClient(account);
    
    if (!client) {
      return res.status(500).json({
        success: false,
        message: 'Could not create Telegram client'
      });
    }
    
    // Log that we're testing directly
    logger.info(`Testing direct Telegram updates for channel ${channel.channel_id} with account ${account.phone_number}`, {
      source: 'message-routes'
    });
    
    // Try to get the entity
    let entity;
    try {
      entity = await client.getEntity(channel.channel_id);
      logger.info(`Successfully fetched entity for ${channel.channel_id}: ${JSON.stringify(entity)}`, {
        source: 'message-routes'
      });
    } catch (entityError) {
      logger.error(`Error getting entity: ${entityError.message}`, {
        source: 'message-routes'
      });
      
      return res.status(500).json({
        success: false,
        message: `Error getting entity: ${entityError.message}`
      });
    }
    
    // Add a simple event handler to test if we receive any updates
    const { NewMessage, Raw } = require('telegram/events');
    
    // Create a promise that will resolve when we receive an event
    const testPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout waiting for events'));
      }, 10000); // Wait 10 seconds max
      
      // Add event handlers for both NewMessage and Raw updates
      let newMessageHandler, rawHandler;
      
      newMessageHandler = (event) => {
        logger.info(`TEST: Received NewMessage event: ${JSON.stringify(safeLogMessage(event.message))}`, {
          source: 'message-routes'
        });
        
        clearTimeout(timeoutId);
        client.removeEventHandler(newMessageHandler);
        client.removeEventHandler(rawHandler);
        resolve({
          type: 'NewMessage',
          data: safeLogMessage(event.message)
        });
      };
      
      rawHandler = (update) => {
        logger.info(`TEST: Received Raw update: ${safeLogMessage(update?.message) || 'unknown'}`, {
          source: 'message-routes'
        });
        
        // We don't resolve for raw updates as they might not be related to our channel
        // But we log them to see if the client is receiving any updates at all
      };
      
      // Add event handlers
      client.addEventHandler(newMessageHandler, new NewMessage({
        chats: [entity.id]
      }));
      
      client.addEventHandler(rawHandler, new Raw({}));
      
      logger.info(`Added test event handlers for channel ${channel.channel_id}`, {
        source: 'message-routes'
      });
    });
    
    // Return immediately, don't wait for events
    res.status(200).json({
      success: true,
      message: `Started event test for channel ${channel.channel_id} with account ${account.phone_number}. Check logs for updates.`
    });
    
    // Handle the test promise in the background
    testPromise.then(result => {
      logger.info(`TEST: Successfully received events: ${JSON.stringify(result)}`, {
        source: 'message-routes'
      });
    }).catch(error => {
      logger.error(`TEST: Error or timeout waiting for events: ${error.message}`, {
        source: 'message-routes'
      });
    });
  } catch (error) {
    logger.error(`Error testing Telegram updates: ${error.message}`, {
      source: 'message-routes',
      stack: error.stack
    });
    
    return res.status(500).json({
      success: false,
      message: 'Error testing Telegram updates',
      error: error.message
    });
  }
});

// Test Telegram connection endpoint
router.get('/test-connection', async (req, res) => {
  try {
    // Find an active account
    const account = await Account.findOne({ 
      status: 'active',
      isBanned: { $ne: true }
    });
    
    if (!account) {
      return res.status(404).json({
        status: 'error',
        message: 'No active accounts found'
      });
    }
    
    // Create a client for testing
    const { createClient } = require('../services/telegram/telegramClient');
    const client = await createClient(account);
    
    // Test connection
    let connectionStatus = 'disconnected';
    let me = null;
    
    try {
      // Check if connected
      if (client.connected) {
        connectionStatus = 'connected';
        
        // Try to get account info
        me = await client.getMe();
        
        // Try to get dialogs to verify further
        const dialogs = await client.getDialogs({ limit: 1 });
        if (dialogs && dialogs.length > 0) {
          connectionStatus = 'fully_operational';
        }
      }
    } catch (telegramError) {
      logger.error(`Error testing Telegram connection: ${telegramError.message}`, {
        source: 'message-routes',
        accountId: account._id.toString(),
        stack: telegramError.stack
      });
    }
    
    // Disconnect to clean up
    try {
      await client.disconnect();
    } catch (disconnectError) {
      logger.warn(`Error disconnecting client: ${disconnectError.message}`, {
        source: 'message-routes'
      });
    }
    
    // Return test results
    res.json({
      status: 'ok',
      account: {
        id: account._id,
        phone: account.phone_number
      },
      connection: {
        status: connectionStatus,
        user: me ? {
          id: me.id,
          username: me.username,
          firstName: me.firstName,
          lastName: me.lastName
        } : null
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Error testing connection: ${error.message}`, {
      source: 'message-routes',
      stack: error.stack
    });
    
    res.status(500).json({
      status: 'error',
      message: `Connection test error: ${error.message}`
    });
  }
});

module.exports = router;