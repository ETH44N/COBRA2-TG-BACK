const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const accountChannelAssignmentSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => uuidv4()
  },
  account_id: {
    type: String,
    ref: 'Account',
    required: true
  },
  channel_id: {
    type: String,
    ref: 'Channel',
    required: true
  },
  assigned_at: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['active', 'failed', 'reassigned'],
    default: 'active'
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

// Ensure unique assignment
accountChannelAssignmentSchema.index({ account_id: 1, channel_id: 1 }, { unique: true });

module.exports = mongoose.model('AccountChannelAssignment', accountChannelAssignmentSchema); 