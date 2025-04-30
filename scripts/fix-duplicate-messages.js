require('dotenv').config();
const mongoose = require('../src/utils/loadModels');
const logger = require('../src/utils/logger');

// Now import models
const Message = mongoose.model('Message');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info('Connected to MongoDB, fixing duplicate messages');
  
  try {
    // Find messages with null message_id
    const nullMessages = await Message.find({ message_id: null });
    
    if (nullMessages.length > 0) {
      logger.info(`Found ${nullMessages.length} messages with null message_id`);
      
      // Delete these messages
      await Message.deleteMany({ message_id: null });
      
      logger.info(`Deleted ${nullMessages.length} messages with null message_id`);
    } else {
      logger.info('No messages with null message_id found');
    }
    
    // Find messages with null telegram_message_id (old field)
    const nullTelegramMessages = await Message.find({ telegram_message_id: null });
    
    if (nullTelegramMessages.length > 0) {
      logger.info(`Found ${nullTelegramMessages.length} messages with null telegram_message_id`);
      
      // Delete these messages
      await Message.deleteMany({ telegram_message_id: null });
      
      logger.info(`Deleted ${nullTelegramMessages.length} messages with null telegram_message_id`);
    } else {
      logger.info('No messages with null telegram_message_id found');
    }
    
    // Find duplicate messages
    const duplicates = await Message.aggregate([
      {
        $group: {
          _id: { channel_id: "$channel_id", message_id: "$message_id" },
          count: { $sum: 1 },
          ids: { $push: "$_id" }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]);
    
    if (duplicates.length > 0) {
      logger.info(`Found ${duplicates.length} groups of duplicate messages`);
      
      // For each group of duplicates, keep the newest one and delete the rest
      for (const group of duplicates) {
        // Get all messages in this group
        const messages = await Message.find({
          channel_id: group._id.channel_id,
          message_id: group._id.message_id
        }).sort({ created_at: -1 });
        
        // Keep the first one (newest) and delete the rest
        const toDelete = messages.slice(1).map(m => m._id);
        
        if (toDelete.length > 0) {
          await Message.deleteMany({ _id: { $in: toDelete } });
          logger.info(`Kept message ${messages[0]._id} and deleted ${toDelete.length} duplicates`);
        }
      }
    } else {
      logger.info('No duplicate messages found');
    }
    
    // Update the index if needed
    try {
      await mongoose.connection.db.collection('messages').dropIndex('channel_id_1_telegram_message_id_1');
      logger.info('Dropped old index channel_id_1_telegram_message_id_1');
    } catch (error) {
      logger.info('Old index not found or already dropped');
    }
    
    // Create the new index
    try {
      await mongoose.connection.db.collection('messages').createIndex(
        { channel_id: 1, message_id: 1 },
        { unique: true }
      );
      logger.info('Created new index channel_id_1_message_id_1');
    } catch (error) {
      logger.error(`Error creating new index: ${error.message}`);
    }
    
    logger.info('Database cleanup completed');
    process.exit(0);
  } catch (error) {
    logger.error(`Error fixing duplicate messages: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 