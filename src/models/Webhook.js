const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const webhookSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => uuidv4()
  },
  url: {
    type: String,
    required: true
  },
  event_type: {
    type: String,
    enum: ['new_message', 'deleted_message', 'all'],
    default: 'all'
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'failed'],
    default: 'active'
  },
  secret_key: {
    type: String,
    required: true
  },
  failure_count: {
    type: Number,
    default: 0
  },
  last_triggered: {
    type: Date
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

module.exports = mongoose.model('Webhook', webhookSchema); 