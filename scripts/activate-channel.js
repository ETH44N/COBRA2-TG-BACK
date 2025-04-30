require('dotenv').config();
const mongoose = require('mongoose');
const { addChannel } = require('../src/services/telegram/channelMonitor');
const logger = require('../src/utils/logger');

// Get channel ID from command line
const channelId = process.argv[2];

if (!channelId) {
  console.error('Please provide a channel ID');
  console.log('Usage: node scripts/activate-channel.js @channelname');
  process.exit(1);
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info(`Connected to MongoDB, activating channel ${channelId}`);
  
  try {
    // Activate the channel
    const channel = await addChannel(channelId);
    
    console.log(`Successfully activated channel: ${channel.name} (${channel.channel_id})`);
    console.log('Channel details:', JSON.stringify(channel, null, 2));
    
    // Keep the process running for a moment to allow logs to be written
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    logger.error(`Error activating channel: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 