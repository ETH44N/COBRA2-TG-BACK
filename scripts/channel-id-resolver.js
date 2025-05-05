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

// Constants for rate limiting and processing
const MIN_DELAY_BETWEEN_REQUESTS = 8000; // 8 seconds minimum between requests
const MAX_RANDOM_DELAY = 7000;  // Up to 7 additional seconds
const ACCOUNT_ROTATION_COUNT = 15; // Switch accounts every 15 requests
const MAX_DAILY_REQUESTS = 150; // Maximum requests per day
const PROGRESS_FILE = path.join(__dirname, 'channel-resolver-progress.json');

// Enhanced proxy configuration for your specific provider
const PROXY_CONFIG = {
  enabled: true,
  type: 'mobile',  // 'residential', 'mobile', or 'esp'
  country: 'us',   // Country code (optional)
  // Your single proxy entry that handles rotation internally
  proxies: [
    { 
      ip: 'rp.scrapegw.com', 
      port: 6060, 
      username: 's702ecpqsnoiptz', 
      password: 'aqxr4fr1x8y3tb4',
      socksType: 5
    }
  ],
  currentIndex: 0
};

// Function to get next proxy
function getNextProxy() {
  if (!PROXY_CONFIG.enabled || PROXY_CONFIG.proxies.length === 0) {
    return null;
  }
  
  PROXY_CONFIG.currentIndex = (PROXY_CONFIG.currentIndex + 1) % PROXY_CONFIG.proxies.length;
  return PROXY_CONFIG.proxies[PROXY_CONFIG.currentIndex];
}

// Function to load progress from file
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = fs.readFileSync(PROGRESS_FILE, 'utf8');
      const progress = JSON.parse(data);
      
      // Reset daily count if it's a new day
      const today = new Date().toISOString().split('T')[0];
      if (progress.lastRequestDate !== today) {
        progress.dailyRequestCount = 0;
        progress.lastRequestDate = today;
      }
      
      return progress;
    } catch (err) {
      console.error('Error reading progress file:', err);
      return { 
        resolved: [], 
        lastIndex: 0,
        dailyRequestCount: 0,
        lastRequestDate: new Date().toISOString().split('T')[0]
      };
    }
  }
  return { 
    resolved: [], 
    lastIndex: 0,
    dailyRequestCount: 0,
    lastRequestDate: new Date().toISOString().split('T')[0]
  };
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
  console.log('Starting channel ID resolution process with enhanced rate limiting...');
  
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  
  // Get multiple active accounts for rotation
  const accounts = await Account.find({ status: 'active' }).limit(10);
  if (accounts.length === 0) {
    console.error('No active accounts found for resolving channel IDs');
    process.exit(1);
  }
  console.log(`Found ${accounts.length} accounts for rotation`);
  
  // Load progress from previous run
  const progress = loadProgress();
  console.log(`Loaded progress: ${progress.resolved.length} channels already resolved`);
  console.log(`Daily request count: ${progress.dailyRequestCount}/${MAX_DAILY_REQUESTS}`);
  
  // Check if we've hit the daily limit
  if (progress.dailyRequestCount >= MAX_DAILY_REQUESTS) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    console.log(`\n==================================================`);
    console.log(`Daily request limit reached (${MAX_DAILY_REQUESTS})`);
    console.log(`Please restart after: ${tomorrow.toLocaleString()}`);
    console.log(`==================================================\n`);
    
    await mongoose.disconnect();
    return;
  }
  
  // Get channels that still need resolution
  const query = { numeric_id: { $exists: false } };
  if (progress.resolved.length > 0) {
    query._id = { $nin: progress.resolved };
  }
  
  // Limit to 50 channels per run to be safer
  const channels = await Channel.find(query).limit(50);
  console.log(`Found ${channels.length} channels left to resolve in this batch`);
  
  if (channels.length === 0) {
    console.log('No channels left to resolve. Exiting.');
    await mongoose.disconnect();
    return;
  }
  
  let currentAccountIndex = 0;
  let client = null;
  
  // Function to switch to next account
  async function switchToNextAccount() {
    // Disconnect previous client if exists
    if (client) {
      await client.disconnect();
    }
    
    // Move to next account
    currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
    const account = accounts[currentAccountIndex];
    
    // With this proxy provider, we don't need to rotate proxies
    // as they handle rotation internally
    const proxy = PROXY_CONFIG.enabled ? PROXY_CONFIG.proxies[0] : null;
    
    const connectionOptions = {
      connectionRetries: 5
    };
    
    // Add proxy if configured
    if (proxy) {
      connectionOptions.proxy = {
        ip: proxy.ip,
        port: proxy.port,
        socksType: proxy.socksType || 5
      };
      
      if (proxy.username && proxy.password) {
        connectionOptions.proxy.username = proxy.username;
        connectionOptions.proxy.password = proxy.password;
      }
      
      console.log(`Using proxy: ${proxy.ip}:${proxy.port}`);
    }
    
    // Create new client
    client = new TelegramClient(
      new StringSession(account.session_string),
      parseInt(process.env.TELEGRAM_API_ID),
      process.env.TELEGRAM_API_HASH,
      connectionOptions
    );
    
    await client.connect();
    console.log(`Switched to account: ${account.phone_number || account.username}`);
    
    // Add a delay after switching
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return client;
  }
  
  // Connect to first account
  client = await switchToNextAccount();
  
  // Process channels with conservative rate limiting and account rotation
  for (let i = 0; i < channels.length; i++) {
    // Check if we've hit the daily limit
    if (progress.dailyRequestCount >= MAX_DAILY_REQUESTS) {
      console.log(`\n==================================================`);
      console.log(`Daily request limit reached (${MAX_DAILY_REQUESTS})`);
      console.log(`Progress saved. Please restart tomorrow.`);
      console.log(`==================================================\n`);
      
      await client.disconnect();
      await mongoose.disconnect();
      return;
    }
    
    // Switch accounts every ACCOUNT_ROTATION_COUNT requests
    if (i > 0 && i % ACCOUNT_ROTATION_COUNT === 0) {
      client = await switchToNextAccount();
    }
    
    const channel = channels[i];
    try {
      // Extract channel username from URL or use as is
      let channelIdentifier = channel.channel_id;
      if (channelIdentifier.startsWith('https://t.me/')) {
        channelIdentifier = channelIdentifier.replace('https://t.me/', '');
      }
      
      console.log(`Attempting to resolve [${i+1}/${channels.length}]: ${channelIdentifier}`);
      
      // Add a random delay before each request
      const randomDelay = MIN_DELAY_BETWEEN_REQUESTS + Math.floor(Math.random() * MAX_RANDOM_DELAY);
      console.log(`Waiting ${(randomDelay/1000).toFixed(1)} seconds before next request...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      
      // Try the alternative method first (getting a message from the channel)
      let entity = null;
      let numericId = null;
      
      try {
        // Try to get a message from the channel - this might be less rate-limited
        const messages = await client.getMessages(channelIdentifier, { limit: 1 });
        if (messages && messages.length > 0 && messages[0].peerId && messages[0].peerId.channelId) {
          numericId = messages[0].peerId.channelId.toString();
          console.log(`Resolved via getMessages: ${numericId}`);
        } else if (messages && messages.chat) {
          numericId = messages.chat.id.toString();
          console.log(`Resolved via getMessages (chat): ${numericId}`);
        }
      } catch (msgError) {
        console.log(`Could not resolve via getMessages: ${msgError.message}`);
        // Fall back to getEntity if getMessages fails
        entity = await client.getEntity(channelIdentifier);
        numericId = entity.id.toString();
        console.log(`Resolved via getEntity: ${numericId}`);
      }
      
      if (!numericId) {
        throw new Error('Could not resolve numeric ID');
      }
      
      // Update channel with numeric ID
      await Channel.updateOne(
        { _id: channel._id },
        { 
          numeric_id: numericId,
          // Optionally update other details if entity is available
          ...(entity ? {
            name: entity.title || channel.name,
            username: entity.username || ''
          } : {})
        }
      );
      
      console.log(`[${i+1}/${channels.length}] Resolved ${channelIdentifier} -> ${numericId}`);
      
      // Update progress
      progress.resolved.push(channel._id);
      progress.lastIndex = i + 1;
      progress.dailyRequestCount++;
      progress.lastRequestDate = new Date().toISOString().split('T')[0];
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
          // For shorter wait times, try switching accounts
          console.log(`Rate limited. Switching accounts and waiting for 60 seconds...`);
          client = await switchToNextAccount();
          await new Promise(resolve => setTimeout(resolve, 60000));
        }
      } else {
        // For other errors, wait a default time
        console.log(`Unknown error. Waiting 30 seconds before trying next channel...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }
  
  console.log('Finished resolving channel IDs for this batch');
  await client.disconnect();
  await mongoose.disconnect();
}

resolveChannelIds().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});