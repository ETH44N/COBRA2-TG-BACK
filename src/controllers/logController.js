const mongoose = require('mongoose');
const logger = require('../utils/logger');

/**
 * Get recent logs from the database
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getRecentLogs = async (req, res) => {
  try {
    // Get query parameters
    const { level, source, limit = 100, since } = req.query;
    
    // Build match conditions
    const match = {};
    
    if (level) {
      match.level = level;
    }
    
    if (source) {
      match.source = source;
    }
    
    if (since) {
      match.timestamp = { $gte: new Date(since) };
    } else {
      // Default to last 24 hours
      match.timestamp = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };
    }
    
    // Direct MongoDB access to the logs collection
    const db = mongoose.connection.db;
    const logs = await db.collection('logs')
      .find(match)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .toArray();
    
    res.status(200).json({
      success: true,
      count: logs.length,
      logs
    });
  } catch (error) {
    logger.error(`API error getting logs: ${error.message}`, {
      source: 'log-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  getRecentLogs
}; 