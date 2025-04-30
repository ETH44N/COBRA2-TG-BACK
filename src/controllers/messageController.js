const Message = require('../models/Message');
const Channel = require('../models/Channel');
const { fetchMessageHistory } = require('../services/telegram/messageListener');
const { getClient } = require('../services/telegram/client');
const AccountChannelAssignment = require('../models/AccountChannelAssignment');
const logger = require('../utils/logger');

/**
 * Get messages for a channel
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getChannelMessages = async (req, res) => {
  try {
    const channelIdentifier = req.params.channelId;
    
    // Find channel by ID or channel_id
    let channel;
    if (channelIdentifier.startsWith('@')) {
      channel = await Channel.findOne({ channel_id: channelIdentifier });
    } else {
      // Try to find by database ID first
      channel = await Channel.findById(channelIdentifier);
      
      // If not found, try without @ prefix
      if (!channel) {
        channel = await Channel.findOne({ channel_id: `@${channelIdentifier}` });
      }
    }
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found'
      });
    }
    
    // Get query parameters
    const limit = parseInt(req.query.limit) || 50;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    const includeDeleted = req.query.includeDeleted === 'true';
    
    // Build query
    const query = { channel_id: channel._id };
    if (!includeDeleted) {
      query.is_deleted = { $ne: true };
    }
    
    // Get messages
    const messages = await Message.find(query)
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit);
    
    // Get total count
    const total = await Message.countDocuments(query);
    
    res.status(200).json({
      success: true,
      count: messages.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: messages
    });
  } catch (error) {
    logger.error(`API error getting channel messages: ${error.message}`, {
      source: 'message-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Fetch message history for a channel
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const fetchHistory = async (req, res) => {
  try {
    const channelIdentifier = req.params.channelId;
    
    // Find channel by ID or channel_id
    let channel;
    if (channelIdentifier.startsWith('@')) {
      channel = await Channel.findOne({ channel_id: channelIdentifier });
    } else {
      // Try to find by database ID first
      channel = await Channel.findById(channelIdentifier);
      
      // If not found, try without @ prefix
      if (!channel) {
        channel = await Channel.findOne({ channel_id: `@${channelIdentifier}` });
      }
    }
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found'
      });
    }
    
    // Get assignment
    const assignment = await AccountChannelAssignment.findOne({
      channel_id: channel._id
    }).populate('account_id');
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Channel is not assigned to any account'
      });
    }
    
    // Get client
    const client = await getClient(assignment.account_id);
    
    // Get limit from query
    const limit = parseInt(req.query.limit) || 100;
    
    // Fetch history
    const result = await fetchMessageHistory(channel, assignment.account_id, client, limit);
    
    res.status(200).json({
      success: true,
      message: `Fetched ${result.count} messages from channel ${channel.channel_id}`,
      data: {
        channel: channel.channel_id,
        messagesProcessed: result.count
      }
    });
  } catch (error) {
    logger.error(`API error fetching message history: ${error.message}`, {
      source: 'message-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get a single message by ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getMessageById = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: message
    });
  } catch (error) {
    logger.error(`API error getting message by ID: ${error.message}`, {
      source: 'message-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  getChannelMessages,
  fetchHistory,
  getMessageById
}; 