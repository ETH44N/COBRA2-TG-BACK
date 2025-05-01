const express = require('express');
const { getChannelMessages, fetchHistory, getMessageById } = require('../controllers/messageController');
const Message = require('../models/Message');
const Channel = require('../models/Channel');
const Account = require('../models/Account');
const AccountChannelAssignment = require('../models/AccountChannelAssignment');
const logger = require('../utils/logger');
const { activeAccountListeners, channelEntityCache } = require('../services/telegram/channelMonitor');
const { RATE_LIMIT, messageQueue } = require('../services/telegram/messageListener');

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
    // Get message counts
    const totalMessages = await Message.countDocuments();
    const deletedMessages = await Message.countDocuments({ is_deleted: true });
    const messagesLast24h = await Message.countDocuments({
      created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });
    
    // Get listener status
    const accountListeners = activeAccountListeners ? Array.from(activeAccountListeners.keys()).length : 'Not available';
    const accountsWithListeners = activeAccountListeners ? Array.from(activeAccountListeners.keys()) : [];
    
    // Get channel stats
    const totalChannels = await Channel.countDocuments();
    const activeChannels = await Channel.countDocuments({ is_active: true });
    
    // Get account stats
    const totalAccounts = await Account.countDocuments();
    const activeAccounts = await Account.countDocuments({ status: 'active', isBanned: { $ne: true } });
    
    // Get assignment stats
    const assignments = await AccountChannelAssignment.countDocuments({ status: 'active' });
    
    // Get rate limit info
    const rateLimitInfo = RATE_LIMIT ? {
      messagesPerMinute: RATE_LIMIT.messagesPerMinute,
      cooldownMs: RATE_LIMIT.cooldownMs,
      accountsTracked: RATE_LIMIT.currentCount ? Object.keys(RATE_LIMIT.currentCount).length : 0
    } : 'Not available';
    
    // Get queue info
    const queueInfo = messageQueue ? {
      queueLength: messageQueue.queue.length,
      isProcessing: messageQueue.isProcessing
    } : 'Not available';
    
    // Get entity cache info
    const entityCacheSize = channelEntityCache ? channelEntityCache.size : 'Not available';
    
    res.json({
      success: true,
      diagnostics: {
        messages: {
          total: totalMessages,
          active: totalMessages - deletedMessages,
          deleted: deletedMessages,
          last24h: messagesLast24h
        },
        channels: {
          total: totalChannels,
          active: activeChannels,
          inactive: totalChannels - activeChannels
        },
        accounts: {
          total: totalAccounts,
          active: activeAccounts,
          inactive: totalAccounts - activeAccounts,
          withListeners: accountsWithListeners.length
        },
        listeners: {
          totalActive: accountListeners,
          accountIds: accountsWithListeners
        },
        assignments: {
          total: assignments
        },
        cache: {
          entityCacheSize
        },
        rateLimiting: rateLimitInfo,
        queue: queueInfo,
        systemInfo: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          timestamp: new Date()
        }
      }
    });
  } catch (error) {
    logger.error(`Error getting message diagnostics: ${error.message}`, {
      source: 'api',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to get diagnostic information'
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
    // Import services with required variables
    const { activeAccountListeners, channelEntityCache } = require('../services/telegram/channelMonitor');
    const { messageQueue, RATE_LIMIT } = require('../services/telegram/messageListener');
    
    // Check if we have the required variables
    if (!activeAccountListeners) {
      return res.status(500).json({
        status: 'error',
        message: 'Could not access activeAccountListeners - module may not be initialized'
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
    for (const [accountId, listener] of activeAccountListeners.entries()) {
      // Get the account information
      const account = await Account.findById(accountId);
      
      // Get channel information for this listener
      const channels = [];
      if (listener.channelIds && listener.channelIds.length > 0) {
        for (const channelId of listener.channelIds) {
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
        channels: channels.slice(0, 5), // Only include up to 5 channels to keep response reasonable
        hasInterval: !!listener.messageCheckInterval,
        clientConnected: listener.client && listener.client.connected
      });
    }
    
    // Return monitor status data
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      activeAccounts,
      activeListeners: {
        count: activeAccountListeners.size,
        listeners: listenersInfo
      },
      messageQueue: {
        length: messageQueue ? messageQueue.queue.length : 0,
        isProcessing: messageQueue ? messageQueue.isProcessing : false,
        rateLimit: RATE_LIMIT
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
        logger.info(`TEST: Received NewMessage event: ${JSON.stringify({
          className: event.className,
          hasMessage: !!event.message,
          messageId: event.message?.id
        })}`, {
          source: 'message-routes'
        });
        
        clearTimeout(timeoutId);
        client.removeEventHandler(newMessageHandler);
        client.removeEventHandler(rawHandler);
        resolve({
          type: 'NewMessage',
          data: {
            messageId: event.message?.id,
            hasMessage: !!event.message
          }
        });
      };
      
      rawHandler = (update) => {
        logger.info(`TEST: Received Raw update: ${update?.className || 'unknown'}`, {
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

module.exports = router; 