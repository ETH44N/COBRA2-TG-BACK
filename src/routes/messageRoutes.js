const express = require('express');
const { getChannelMessages, fetchHistory, getMessageById } = require('../controllers/messageController');

const router = express.Router();

// Get messages for a channel
router.get('/channel/:channelId', getChannelMessages);

// Fetch message history for a channel
router.post('/channel/:channelId/fetch-history', fetchHistory);

// Get a single message by ID
router.get('/:id', getMessageById);

module.exports = router; 