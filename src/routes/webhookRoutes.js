const express = require('express');
const { addWebhook, getAllWebhooks, getWebhookDeliveries } = require('../controllers/webhookController');
const { validate, schemas } = require('../utils/validators');

const router = express.Router();

// Add a new webhook
router.post('/', validate(schemas.webhook), addWebhook);

// Get all webhooks
router.get('/', getAllWebhooks);

// Get webhook deliveries
router.get('/deliveries', getWebhookDeliveries);

module.exports = router; 