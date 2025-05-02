// channel-id-resolver.js
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// Use path.join to correctly resolve paths relative to the project root
const Channel = require(path.join(__dirname, '../src/models/Channel'));
const Account = require(path.join(__dirname, '../src/models/Account'));
const logger = require(path.join(__dirname, '../src/utils/logger'));

// Constants for rate limiting
const MIN_DELAY_BETWEEN_REQUESTS = 5000; // 5 seconds minimum between requests
const PROGRESS_FILE = path.join(__dirname, 'channel-resolver-progress.json');

// Function to load progress from file
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = fs.readFileSync(PROGRESS_FILE, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading progress file:', err);
      return { resolved: [], lastIndex: 0 };
    }
  }
  return { resolved: [], lastIndex: 0 };
}

// Function to save progress to file
function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving progress:', err);
  }
}

async function resolveChannelIds() {
  console.log('Starting channel ID resolution process...');
  
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
  console.log('Connected to Telegram');
  
  // Load progress from previous run
  const progress = loadProgress();
  console.log(`Loaded progress: ${progress.resolved.length} channels already resolved`);
  
  // Get all channels without numeric IDs, excluding already resolved ones
  const query = { numeric_id: { $exists: false } };
  if (progress.resolved.length > 0) {
    query._id = { $nin: progress.resolved };
  }
  
  const channels = await Channel.find(query);
  console.log(`Found ${channels.length} channels left to resolve`);
  
  if (channels.length === 0) {
    console.log('No channels left to resolve. Exiting.');
    await client.disconnect();
    await mongoose.disconnect();
    return;
  }
  
  // Process channels with very conservative rate limiting
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    try {
      // Extract channel username from URL or use as is
      let channelIdentifier = channel.channel_id;
      if (channelIdentifier.startsWith('https://t.me/')) {
        channelIdentifier = channelIdentifier.replace('https://t.me/', '');
      }
      
      console.log(`Attempting to resolve [${i+1}/${channels.length}]: ${channelIdentifier}`);
      
      // Add a random delay before each request (5-10 seconds)
      const randomDelay = MIN_DELAY_BETWEEN_REQUESTS + Math.floor(Math.random() * 5000);
      console.log(`Waiting ${randomDelay/1000} seconds before next request...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      
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
      
      // Update progress
      progress.resolved.push(channel._id);
      progress.lastIndex = i + 1;
      saveProgress(progress);
      
    } catch (error) {
      console.error(`Error resolving ${channel.channel_id}: ${error.message}`);
      
      // If we hit rate limit, handle it gracefully
      if (error.message.includes('wait of') && error.message.includes('seconds is required')) {
        const waitMatch = error.message.match(/wait of (\d+) seconds/);
        const waitTime = waitMatch ? parseInt(waitMatch[1]) : 3600; // Default to 1 hour if can't parse
        
        // Save progress before waiting
        saveProgress(progress);
        
        // If wait time is very long (> 1 hour), exit and tell user when to restart
        if (waitTime > 3600) {
          const restartTime = new Date(Date.now() + waitTime * 1000);
          console.log(`\n=====================================================`);
          console.log(`Hit severe rate limit. Wait time: ${waitTime} seconds (${(waitTime/3600).toFixed(2)} hours)`);
          console.log(`Please restart this script after: ${restartTime.toLocaleString()}`);
          console.log(`Progress saved. Run the same script again after waiting.`);
          console.log(`=====================================================\n`);
          
          await client.disconnect();
          await mongoose.disconnect();
          return;
        } else {
          // For shorter wait times, pause execution
          console.log(`Rate limited. Waiting for ${waitTime + 60} seconds (${((waitTime+60)/60).toFixed(2)} minutes)...`);
          await new Promise(resolve => setTimeout(resolve, (waitTime + 60) * 1000));
        }
      } else {
        // For other errors, wait a default time
        console.log(`Unknown error. Waiting 30 seconds before trying next channel...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }
  
  console.log('Finished resolving all channel IDs');
  await client.disconnect();
  await mongoose.disconnect();
}

resolveChannelIds().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});