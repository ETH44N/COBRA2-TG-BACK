/**
 * Helper module to load all mongoose models
 * This ensures models are properly registered before being used
 */

// Load all models in the correct order
require('../models/Account');
require('../models/Channel');
require('../models/Message');
require('../models/AccountChannelAssignment');
require('../models/Webhook');
require('../models/WebhookDelivery');

// Export mongoose to allow direct access to models
module.exports = require('mongoose'); 