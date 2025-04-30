require('dotenv').config();
const mongoose = require('mongoose');
const { processNewMessage } = require('../src/services/telegram/messageListener');
const Channel = require('../src/models/Channel');
const logger = require('../src/utils/logger');

// Get channel ID from command line
const channelId = process.argv[2];

if (!channelId) {
  console.error('Please provide a channel ID');
  console.log('Usage: node scripts/test-message-processing.js @channelname');
  process.exit(1);
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info(`Connected to MongoDB, testing message processing for channel ${channelId}`);
  
  try {
    // Find the channel
    const channel = await Channel.findOne({ channel_id: channelId });
    
    if (!channel) {
      console.error(`Channel ${channelId} not found`);
      process.exit(1);
    }
    
    // Create a test message
    const testMessage = {
      id: Math.floor(Math.random() * 1000000),
      message: 'This is a test message from the message processing test script',
      date: Math.floor(Date.now() / 1000),
      fromId: {
        userId: 12345
      }
    };
    
    // Process the message
    const result = await processNewMessage(channel._id, testMessage, null);
    
    console.log('Test message processed successfully:');
    console.log(JSON.stringify(result, null, 2));
    
    // Keep the process running for a moment to allow logs to be written
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    logger.error(`Error testing message processing: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 