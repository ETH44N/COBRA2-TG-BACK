const Channel = require('../models/Channel');
const { addChannel, reassignChannel, getMonitoringStatus, fixChannelMonitoring } = require('../services/telegram/channelMonitor');
const logger = require('../utils/logger');

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

module.exports = {
  addNewChannel,
  getAllChannels,
  getChannelById,
  updateChannel,
  deleteChannel,
  getChannelMonitoringStatus,
  fixChannelMonitoringIssues
}; 