const Channel = require('../models/Channel');
const { addChannel, reassignChannel, getMonitoringStatus, fixChannelMonitoring } = require('../services/telegram/channelMonitor');
const logger = require('../utils/logger');
const AccountChannelAssignment = require('../models/AccountChannelAssignment');
const Message = require('../models/Message');

/**
 * Add a new channel to monitor
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const addNewChannel = async (req, res) => {
  try {
    const { channel_id, name } = req.body;
    
    if (!channel_id) {
      return res.status(400).json({
        success: false,
        message: 'Channel ID is required'
      });
    }
    
    // First check if channel already exists
    let existingChannel = await Channel.findOne({ channel_id });
    
    if (existingChannel) {
      return res.status(200).json({
        success: true,
        message: 'Channel already exists',
        data: existingChannel
      });
    }
    
    // Create a temporary channel object with the provided name
    // The actual channel details will be updated after joining
    const tempChannel = await Channel.create({
      channel_id,
      name: name || channel_id, // Use provided name or channel_id as fallback
      is_active: false
    });
    
    // Now add the channel through the service which will handle joining and monitoring
    const channel = await addChannel(channel_id);
    
    res.status(201).json({
      success: true,
      message: 'Channel added successfully',
      data: channel
    });
  } catch (error) {
    logger.error(`API error adding channel: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get all monitored channels
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAllChannels = async (req, res) => {
  try {
    const channels = await Channel.find({});
    
    res.status(200).json({
      success: true,
      count: channels.length,
      data: channels
    });
  } catch (error) {
    logger.error(`API error getting channels: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get a specific channel by ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getChannelById = async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.id);
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: channel
    });
  } catch (error) {
    logger.error(`API error getting channel: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Update a channel
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const updateChannel = async (req, res) => {
  try {
    const channel = await Channel.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: channel
    });
  } catch (error) {
    logger.error(`API error updating channel: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Delete a channel
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const deleteChannel = async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.id);
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found'
      });
    }
    
    await channel.remove();
    
    res.status(200).json({
      success: true,
      message: 'Channel deleted successfully'
    });
  } catch (error) {
    logger.error(`API error deleting channel: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get channel monitoring status
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getChannelMonitoringStatus = async (req, res) => {
  try {
    const status = await getMonitoringStatus();
    
    res.status(200).json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error(`API error getting monitoring status: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Fix channel monitoring issues
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const fixChannelMonitoringIssues = async (req, res) => {
  try {
    const result = await fixChannelMonitoring();
    
    res.status(200).json({
      success: true,
      message: `Fixed ${result.fixed_count} channel monitoring issues`,
      data: result
    });
  } catch (error) {
    logger.error(`API error fixing channel monitoring: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Search for channels by name, username, or ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const searchChannels = async (req, res) => {
  try {
    const { term } = req.query;
    
    if (!term) {
      return res.status(400).json({
        success: false,
        message: 'Search term is required'
      });
    }
    
    // Search for channels by various fields
    const channels = await Channel.find({
      $or: [
        { name: { $regex: term, $options: 'i' } },
        { username: { $regex: term, $options: 'i' } },
        { channel_id: { $regex: term, $options: 'i' } },
        { numeric_id: { $regex: term, $options: 'i' } }
      ]
    }).lean();
    
    // Get monitoring status to determine which channels have active listeners
    const monitoringStatus = await getMonitoringStatus();
    const activeListeners = new Set();
    
    // Create a set of channel IDs with active listeners
    if (monitoringStatus.monitored_channels > 0) {
      monitoringStatus.channels_without_listeners.forEach(channel => {
        activeListeners.add(channel.id.toString());
      });
    }
    
    // Get account assignments for these channels
    const channelIds = channels.map(channel => channel._id);
    const assignments = await AccountChannelAssignment.find({
      channel_id: { $in: channelIds },
      status: 'active'
    }).populate('account_id').lean();
    
    // Create a map of channel ID to account
    const channelAccountMap = {};
    assignments.forEach(assignment => {
      channelAccountMap[assignment.channel_id.toString()] = assignment.account_id;
    });
    
    // Enrich channel data with listener status and account information
    const enrichedChannels = channels.map(channel => {
      const channelId = channel._id.toString();
      return {
        ...channel,
        has_listener: !activeListeners.has(channelId),
        account: channelAccountMap[channelId] || null
      };
    });
    
    res.status(200).json({
      success: true,
      count: enrichedChannels.length,
      channels: enrichedChannels
    });
  } catch (error) {
    logger.error(`API error searching channels: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Fix channel listener
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const fixChannelListener = async (req, res) => {
  try {
    const channelId = req.params.id;
    
    // Get channel
    const channel = await Channel.findById(channelId);
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found'
      });
    }
    
    // Attempt to reassign the channel to fix the listener
    const result = await reassignChannel(channel);
    
    res.status(200).json({
      success: true,
      message: 'Channel listener fixed',
      data: result
    });
  } catch (error) {
    logger.error(`API error fixing channel listener: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Fix channel numeric ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const fixChannelNumericId = async (req, res) => {
  try {
    const channelId = req.params.id;
    
    // Get channel
    const channel = await Channel.findById(channelId);
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found'
      });
    }
    
    // Get assignment
    const assignment = await AccountChannelAssignment.findOne({
      channel_id: channelId,
      status: 'active'
    }).populate('account_id');
    
    if (!assignment) {
      return res.status(400).json({
        success: false,
        message: 'No active account assignment found for this channel'
      });
    }
    
    // Get client for account
    const { getClient } = require('../services/telegram/client');
    const client = await getClient(assignment.account_id);
    
    // Get entity for channel
    const entity = await client.getEntity(channel.channel_id);
    
    // Extract numeric ID
    const numericId = entity.id?.toString();
    
    if (!numericId) {
      return res.status(500).json({
        success: false,
        message: 'Could not get numeric ID for channel'
      });
    }
    
    // Update channel
    await Channel.updateOne(
      { _id: channel._id },
      { 
        numeric_id: numericId,
        name: entity.title || channel.name,
        username: entity.username || null
      }
    );
    
    res.status(200).json({
      success: true,
      message: 'Channel numeric ID fixed',
      numeric_id: numericId
    });
  } catch (error) {
    logger.error(`API error fixing channel numeric ID: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Fix all channels with missing numeric IDs
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const fixAllNumericIds = async (req, res) => {
  try {
    // Run the script from a module
    const fixMissingNumericIds = require('../scripts/fixMissingNumericIds');
    const result = await fixMissingNumericIds();
    
    res.status(200).json({
      success: true,
      message: `Fixed ${result.fixed} channels with missing numeric IDs`,
      fixed: result.fixed,
      failed: result.failed
    });
  } catch (error) {
    logger.error(`API error fixing all numeric IDs: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Check if a specific channel is being properly monitored
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const checkChannelMonitoring = async (req, res) => {
  try {
    const { channelId } = req.params;
    
    if (!channelId) {
      return res.status(400).json({
        success: false,
        message: 'Channel ID is required'
      });
    }
    
    // Find channel in database
    const channel = await Channel.findOne({
      $or: [
        { channel_id: channelId },
        { username: channelId },
        { numeric_id: channelId }
      ]
    });
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: `Channel ${channelId} not found in database`
      });
    }
    
    // Get assignment
    const assignment = await AccountChannelAssignment.findOne({
      channel_id: channel._id
    }).populate('account_id');
    
    // Check if listener is active
    const activeListeners = require('../services/telegram/channelMonitor').activeListeners;
    const hasActiveListener = activeListeners && activeListeners.has(channel._id.toString());
    
    // Get message stats
    const totalMessages = await Message.countDocuments({ channel_id: channel._id });
    const lastMessage = await Message.findOne({ channel_id: channel._id })
      .sort({ date: -1 })
      .select('date message_id')
      .lean();
    
    // Calculate time since last message
    let timeSinceLastMessage = null;
    if (lastMessage) {
      timeSinceLastMessage = Date.now() - new Date(lastMessage.date).getTime();
      timeSinceLastMessage = Math.floor(timeSinceLastMessage / (1000 * 60)); // Convert to minutes
    }
    
    const status = {
      channel_info: {
        id: channel._id,
        channel_id: channel.channel_id,
        name: channel.name,
        username: channel.username,
        numeric_id: channel.numeric_id,
        is_active: channel.is_active,
        last_checked: channel.last_checked,
        date_joined: channel.date_joined
      },
      monitoring_status: {
        has_active_listener: hasActiveListener,
        assigned_to_account: assignment ? assignment.account_id.phone_number : null,
        account_status: assignment ? assignment.account_id.status : null
      },
      message_stats: {
        total_messages: totalMessages,
        last_message_at: lastMessage ? lastMessage.date : null,
        minutes_since_last_message: timeSinceLastMessage,
        last_message_id: lastMessage ? lastMessage.message_id : null
      },
      last_error: channel.last_error,
      last_error_at: channel.last_error_at
    };
    
    return res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    logger.error(`Error checking channel monitoring: ${error.message}`, {
      source: 'channel-controller',
      context: { error: error.stack }
    });
    
    return res.status(500).json({
      success: false,
      message: `Error checking channel monitoring: ${error.message}`
    });
  }
};

module.exports = {
  addNewChannel,
  getAllChannels,
  getChannelById,
  updateChannel,
  deleteChannel,
  getChannelMonitoringStatus,
  fixChannelMonitoringIssues,
  searchChannels,
  fixChannelListener,
  fixChannelNumericId,
  fixAllNumericIds,
  checkChannelMonitoring
}; 