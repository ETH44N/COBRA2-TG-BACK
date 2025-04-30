const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const accountSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => uuidv4()
  },
  username: {
    type: String,
    required: true
  },
  phone_number: {
    type: String,
    required: true
  },
  session_string: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'banned', 'limited', 'inactive'],
    default: 'inactive'
  },
  last_active: {
    type: Date,
    default: Date.now
  },
  max_channels: {
    type: Number,
    default: 50
  },
  current_channels_count: {
    type: Number,
    default: 0
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

module.exports = mongoose.model('Account', accountSchema); 