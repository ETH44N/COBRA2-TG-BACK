const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const messageSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => uuidv4()
  },
  channel_id: {
    type: String,
    ref: 'Channel',
    required: true
  },
  message_id: {
    type: Number,
    required: true
  },
  sender_id: {
    type: String
  },
  sender_name: {
    type: String
  },
  text: {
    type: String
  },
  media_type: {
    type: String,
    enum: ['photo', 'video', 'document', 'audio', 'sticker', 'animation', 'poll', 'contact', 'location', 'none'],
    default: 'none'
  },
  media_url: {
    type: String
  },
  is_deleted: {
    type: Boolean,
    default: false
  },
  deleted_at: {
    type: Date
  },
  raw_data: {
    type: Object
  },
  date: {
    type: Date,
    required: true
  },
  forwarded_from: {
    type: String
  },
  reply_to_message_id: {
    type: Number
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

// Compound index for efficient lookups
messageSchema.index({ channel_id: 1, message_id: 1 }, { unique: true });

// If there's an existing index with telegram_message_id, we need to drop it
// This will be handled by the fix-duplicate-messages.js script

module.exports = mongoose.model('Message', messageSchema); 