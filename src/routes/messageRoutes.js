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

// Get event monitoring status
router.get('/monitor-status', async (req, res) => {
  try {
    const { channelMonitor } = require('../services/telegram/channelMonitor');
    const { RATE_LIMIT, messageQueue } = require('../services/telegram/messageListener');
    
    // Get active accounts and their listeners
    const accounts = await Account.find({ status: 'active' }).lean();
    const activeListeners = [];
    
    for (const account of accounts) {
      const accountId = account._id.toString();
      const hasListener = channelMonitor && channelMonitor.activeAccountListeners && 
                        channelMonitor.activeAccountListeners.has(accountId);
                        
      activeListeners.push({
        account_id: accountId,
        phone: account.phone_number,
        has_active_listener: hasListener,
        monitored_channels: hasListener ? 
          channelMonitor.activeAccountListeners.get(accountId).channelIds.length : 0
      });
    }
    
    // Get rate limits and queue status
    const rateLimit = {
      accounts: Object.keys(RATE_LIMIT.accounts).length,
      details: RATE_LIMIT.accounts
    };
    
    const queue = {
      length: messageQueue.queue.length,
      is_processing: messageQueue.isProcessing
    };
    
    return res.status(200).json({
      success: true,
      data: {
        active_listeners: activeListeners,
        rate_limit: rateLimit,
        queue: queue,
        total_entity_cache: channelMonitor ? channelMonitor.channelEntityCache.size : 0
      }
    });
  } catch (error) {
    logger.error(`Error getting monitor status: ${error.message}`, {
      source: 'message-routes',
      stack: error.stack
    });
    
    return res.status(500).json({
      success: false,
      message: 'Error getting monitor status',
      error: error.message
    });
  }
});

module.exports = router; 