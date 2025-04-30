require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');

// Import models
require('../src/models/Account');
require('../src/models/Channel');
require('../src/models/Message');

// Now import services that use these models
const Message = mongoose.model('Message');
const { processDeletedMessage } = require('../src/services/telegram/messageListener');

// Get message ID from command line
const messageId = process.argv[2];

if (!messageId) {
  console.error('Please provide a message ID');
  console.log('Usage: node scripts/test-message-deletion.js <message_id>');
  process.exit(1);
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info(`Connected to MongoDB, testing message deletion for message ${messageId}`);
  
  try {
    // Find the message
    const message = await Message.findById(messageId);
    
    if (!message) {
      console.error(`Message ${messageId} not found`);
      process.exit(1);
    }
    
    console.log('Found message:');
    console.log(JSON.stringify(message, null, 2));
    
    // Process the message as deleted
    const result = await processDeletedMessage(message.channel_id, message.message_id);
    
    console.log('Message marked as deleted:');
    console.log(JSON.stringify(result, null, 2));
    
    // Keep the process running for a moment to allow logs to be written
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    logger.error(`Error testing message deletion: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 