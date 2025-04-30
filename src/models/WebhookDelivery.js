const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const webhookDeliverySchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => uuidv4()
  },
  webhook_id: {
    type: String,
    ref: 'Webhook',
    required: true
  },
  message_id: {
    type: String,
    ref: 'Message'
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  status_code: {
    type: Number
  },
  response: {
    type: String
  },
  triggered_at: {
    type: Date,
    required: true,
    default: Date.now
  },
  completed_at: {
    type: Date
  },
  success: {
    type: Boolean,
    default: false
  }
});

module.exports = mongoose.model('WebhookDelivery', webhookDeliverySchema); 