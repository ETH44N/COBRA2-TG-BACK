const express = require('express');
const { 
  addNewChannel, 
  getAllChannels, 
  getChannelById,
  getChannelMonitoringStatus,
  fixChannelMonitoringIssues
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

// Get a specific channel
router.get('/:id', getChannelById);

module.exports = router; 