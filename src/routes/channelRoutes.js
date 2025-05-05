const express = require('express');
const { 
  addNewChannel, 
  getAllChannels, 
  getChannelById,
  getChannelMonitoringStatus,
  fixChannelMonitoringIssues,
  searchChannels,
  fixChannelListener,
  fixChannelNumericId,
  fixAllNumericIds,
  checkChannelMonitoring
} = require('../controllers/channelController');
const { validate, schemas } = require('../utils/validators');

const router = express.Router();

// Add a new channel
router.post('/', validate(schemas.channel), addNewChannel);

// Get all channels
router.get('/', getAllChannels);

// Get channel monitoring status 
// Note: This must come before the '/:id' route to avoid conflicts
router.get('/monitoring/status', getChannelMonitoringStatus);

// Fix channel monitoring issues
router.post('/monitoring/fix', fixChannelMonitoringIssues);

// Search channels
router.get('/search', searchChannels);

// Fix all missing numeric IDs
router.post('/fix-numeric-ids', fixAllNumericIds);

// Fix channel listener for specific channel
router.post('/:id/fix-listener', fixChannelListener);

// Fix numeric ID for specific channel
router.post('/:id/fix-numeric-id', fixChannelNumericId);

// Get a specific channel
router.get('/:id', getChannelById);

/**
 * @route GET /api/channels/status/:channelId
 * @desc Check monitoring status of a specific channel
 * @access Private
 */
router.get('/status/:channelId', checkChannelMonitoring);

module.exports = router; 