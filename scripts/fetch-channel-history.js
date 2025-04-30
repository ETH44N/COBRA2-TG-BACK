require('dotenv').config();
const mongoose = require('../src/utils/loadModels');
const logger = require('../src/utils/logger');

// Now import services that use these models
const Channel = mongoose.model('Channel');
const AccountChannelAssignment = mongoose.model('AccountChannelAssignment');
const { getClient } = require('../src/services/telegram/client');
const { fetchMessageHistory } = require('../src/services/telegram/messageListener');

// Get channel ID from command line
const channelId = process.argv[2];
const limit = parseInt(process.argv[3]) || 100;

if (!channelId) {
  console.error('Please provide a channel ID');
  console.log('Usage: node scripts/fetch-channel-history.js @channelname [limit]');
  process.exit(1);
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info(`Connected to MongoDB, fetching history for channel ${channelId}`);
  
  try {
    // Find channel
    let channel;
    if (channelId.startsWith('@')) {
      channel = await Channel.findOne({ channel_id: channelId });
    } else {
      channel = await Channel.findOne({ channel_id: `@${channelId}` });
    }
    
    if (!channel) {
      console.error(`Channel ${channelId} not found`);
      process.exit(1);
    }
    
    // Get assignment
    const assignment = await AccountChannelAssignment.findOne({
      channel_id: channel._id
    }).populate('account_id');
    
    if (!assignment) {
      console.error(`Channel ${channelId} is not assigned to any account`);
      process.exit(1);
    }
    
    // Get client
    const client = await getClient(assignment.account_id);
    
    // Fetch history
    console.log(`Fetching up to ${limit} messages from channel ${channel.channel_id}...`);
    const result = await fetchMessageHistory(channel, assignment.account_id, client, limit);
    
    console.log(`Successfully processed ${result.count} messages from channel ${channel.channel_id}`);
    
    // Keep the process running for a moment to allow logs to be written
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    logger.error(`Error fetching channel history: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 