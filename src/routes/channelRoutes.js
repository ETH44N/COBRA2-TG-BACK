const express = require('express');
const { addNewChannel, getAllChannels, getChannelById } = require('../controllers/channelController');
const { validate, schemas } = require('../utils/validators');

const router = express.Router();

// Add a new channel
router.post('/', validate(schemas.channel), addNewChannel);

// Get all channels
router.get('/', getAllChannels);

// Get a specific channel
router.get('/:id', getChannelById);

module.exports = router; 