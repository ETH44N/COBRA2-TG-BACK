const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const channelSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => uuidv4()
  },
  channel_id: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  name: {
    type: String,
    required: false,
    trim: true
  },
  username: {
    type: String,
    trim: true
  },
  joined_by_account_id: {
    type: String,
    ref: 'Account'
  },
  date_joined: {
    type: Date,
    default: Date.now
  },
  is_active: {
    type: Boolean,
    default: false
  },
  last_message_at: {
    type: Date
  },
  description: {
    type: String
  },
  member_count: {
    type: Number
  },
  last_checked: {
    type: Date
  },
  last_error: {
    type: String
  },
  last_error_at: {
    type: Date
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

module.exports = mongoose.model('Channel', channelSchema); 