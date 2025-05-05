const express = require('express');
const { getRecentLogs } = require('../controllers/logController');

const router = express.Router();

// Get recent logs
router.get('/', getRecentLogs);

module.exports = router; 