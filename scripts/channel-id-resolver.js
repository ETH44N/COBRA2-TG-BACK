// channel-id-resolver.js
const mongoose = require('mongoose');
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const Channel = require('./src/models/Channel');
const Account = require('./src/models/Account');
const logger = require('./src/utils/logger');

async function resolveChannelIds() {
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  
  // Get a valid account for resolving
  const account = await Account.findOne({ status: 'active' });
  if (!account) {
    console.error('No active account found for resolving channel IDs');
    process.exit(1);
  }
  
  // Create Telegram client
  const client = new TelegramClient(
    new StringSession(account.session_string),
    parseInt(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  );
  
  await client.connect();
  
  // Get all channels without numeric IDs
  const channels = await Channel.find({
    numeric_id: { $exists: false } 
  });
  
  console.log(`Found ${channels.length} channels to resolve`);
  
  // Process channels with rate limiting
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    try {
      // Extract channel username from URL or use as is
      let channelIdentifier = channel.channel_id;
      if (channelIdentifier.startsWith('https://t.me/')) {
        channelIdentifier = channelIdentifier.replace('https://t.me/', '');
      }
      
      // Resolve the entity
      const entity = await client.getEntity(channelIdentifier);
      
      // Update channel with numeric ID
      await Channel.updateOne(
        { _id: channel._id },
        { 
          numeric_id: entity.id.toString(),
          // Optionally update other details
          name: entity.title || channel.name,
          username: entity.username || ''
        }
      );
      
      console.log(`[${i+1}/${channels.length}] Resolved ${channelIdentifier} -> ${entity.id}`);
      
      // Add delay to avoid rate limiting (1 second between requests)
      if (i < channels.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`Error resolving ${channel.channel_id}: ${error.message}`);
      
      // If we hit rate limit, wait the required time plus a buffer
      if (error.message.includes('flood wait')) {
        const waitTime = parseInt(error.message.match(/A wait of (\d+) seconds/)[1]) || 60;
        console.log(`Rate limited. Waiting for ${waitTime + 10} seconds...`);
        await new Promise(resolve => setTimeout(resolve, (waitTime + 10) * 1000));
      } else {
        // For other errors, wait a default time
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  
  console.log('Finished resolving channel IDs');
  await client.disconnect();
  await mongoose.disconnect();
}

resolveChannelIds().catch(console.error);