const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const logSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => uuidv4()
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  level: {
    type: String,
    enum: ['info', 'warning', 'error', 'critical'],
    required: true
  },
  message: {
    type: String,
    required: true
  },
  context: {
    type: mongoose.Schema.Types.Mixed
  },
  account_id: {
    type: String,
    ref: 'Account'
  },
  channel_id: {
    type: String,
    ref: 'Channel'
  },
  source: {
    type: String
  }
});

module.exports = mongoose.model('Log', logSchema); 