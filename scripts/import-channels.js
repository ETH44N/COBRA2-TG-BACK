require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');
const Channel = require('../src/models/Channel');
const Account = require('../src/models/Account');
const AccountChannelAssignment = require('../src/models/AccountChannelAssignment');
const { getClient } = require('../src/services/telegram/client');
const { Api } = require('telegram/tl');

// Parse command line arguments
const args = process.argv.slice(2);
const fileArg = args.find(arg => arg.startsWith('--file='));
const customFile = fileArg ? fileArg.split('=')[1] : null;

// Configuration
const CHANNELS_FILE = customFile 
  ? path.join(__dirname, '..', customFile) 
  : path.join(__dirname, '../channels.txt');
let BATCH_SIZE = 5; // Process 5 channels at a time
let BATCH_DELAY_MS = 0; // 1 hour between batches
let CHANNEL_DELAY_MS = 2000; // 5 minutes between channel joins
const MAX_CHANNELS_PER_ACCOUNT = parseInt(process.env.MAX_CHANNELS_PER_ACCOUNT || '40', 10);
const SAFE_JOIN_LIMIT_PER_DAY = 15; // Conservative limit for channel joins per account per day

// For test mode, use much shorter delays
const TEST_MODE = args.includes('--test');
if (TEST_MODE) {
  logger.info('Running in TEST mode with shorter delays');
  BATCH_DELAY_MS = 60000; // 1 minute between batches
  CHANNEL_DELAY_MS = 10000; // 10 seconds between channel joins
}

let activeAccounts = []; // Will store active accounts from database
let joinsByAccount = {}; // Track joins per account for the current day
let totalAdded = 0;
let totalFailed = 0;
let isRunning = false;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('Connected to MongoDB for channel import');
  logger.info(`Using channels file: ${CHANNELS_FILE}`);
  startImport();
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

async function startImport() {
  try {
    // Load active accounts
    await loadActiveAccounts();
    
    if (activeAccounts.length === 0) {
      logger.error('No active accounts found, exiting');
      process.exit(1);
    }
    
    // Load channels from file
    const channels = await readChannelsFromFile();
    logger.info(`Found ${channels.length} channels in the file`);
    
    // Check if channels are already in the database
    const existingChannelUrls = await getAllExistingChannelUrls();
    const newChannels = channels.filter(url => !existingChannelUrls.includes(url));
    
    logger.info(`Found ${existingChannelUrls.length} existing channels in database`);
    logger.info(`${newChannels.length} new channels to add`);
    
    if (newChannels.length === 0) {
      logger.info('No new channels to add, exiting');
      process.exit(0);
    }
    
    // Process channels in batches with delays
    isRunning = true;
    await processChannelsInBatches(newChannels);
    
  } catch (error) {
    logger.error(`Error starting import: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
}

async function loadActiveAccounts() {
  try {
    // Get active accounts with their current channel counts
    activeAccounts = await Account.find({ 
      status: 'active',
      isBanned: { $ne: true } 
    });
    
    logger.info(`Loaded ${activeAccounts.length} active accounts`);
    
    // Initialize join tracking
    activeAccounts.forEach(account => {
      joinsByAccount[account._id] = 0;
    });
    
    return activeAccounts;
  } catch (error) {
    logger.error(`Error loading accounts: ${error.message}`);
    throw error;
  }
}

async function readChannelsFromFile() {
  try {
    const fileContent = fs.readFileSync(CHANNELS_FILE, 'utf8');
    return fileContent.split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => line.trim());
  } catch (error) {
    logger.error(`Error reading channels file: ${error.message}`);
    throw error;
  }
}

async function getAllExistingChannelUrls() {
  try {
    const existingChannels = await Channel.find({}, { channel_id: 1 });
    return existingChannels.map(channel => channel.channel_id);
  } catch (error) {
    logger.error(`Error getting existing channels: ${error.message}`);
    throw error;
  }
}

async function processChannelsInBatches(channels) {
  // Create results log file
  const logFile = fs.createWriteStream(path.join(__dirname, '../channel-import-results.log'), { flags: 'a' });
  logFile.write(`\n\n--- Channel Import Started at ${new Date().toISOString()} ---\n`);
  
  try {
    for (let i = 0; i < channels.length; i += BATCH_SIZE) {
      if (!isRunning) {
        logger.info('Import process was stopped');
        break;
      }
      
      const batchStartTime = new Date();
      const batch = channels.slice(i, i + BATCH_SIZE);
      
      logger.info(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(channels.length/BATCH_SIZE)}`);
      
      // Process each channel in batch sequentially with delay
      for (const channelUrl of batch) {
        try {
          // Get best account for the channel with least number of channels and joins today
          const account = await getBestAccountForChannel();
          
          if (!account) {
            logger.warn(`No suitable account available for channel ${channelUrl}, skipping`);
            logFile.write(`${channelUrl} | SKIPPED | No suitable account available\n`);
            totalFailed++;
            continue;
          }
          
          // Add channel
          const result = await addChannel(channelUrl, account);
          
          if (result.success) {
            logger.info(`Successfully added channel ${channelUrl} with account ${account.phone_number}`);
            logFile.write(`${channelUrl} | SUCCESS | Added with account ${account.phone_number}\n`);
            
            // Update joins count for this account
            joinsByAccount[account._id]++;
            totalAdded++;
          } else {
            logger.error(`Failed to add channel ${channelUrl}: ${result.error}`);
            logFile.write(`${channelUrl} | FAILED | ${result.error}\n`);
            totalFailed++;
          }
          
          // Wait between channel joins
          if (CHANNEL_DELAY_MS >= 60000) {
            logger.info(`Waiting ${(CHANNEL_DELAY_MS / 60000).toFixed(2)} minutes before next channel join...`);
          } else {
            logger.info(`Waiting ${CHANNEL_DELAY_MS / 1000} seconds before next channel join...`);
          }          await new Promise(resolve => setTimeout(resolve, CHANNEL_DELAY_MS));
        } catch (error) {
          logger.error(`Error processing channel ${channelUrl}: ${error.message}`);
          logFile.write(`${channelUrl} | ERROR | ${error.message}\n`);
          totalFailed++;
        }
      }
      
      // Log batch completion
      const batchEndTime = new Date();
      const batchDuration = (batchEndTime - batchStartTime) / 60000; // in minutes
      logger.info(`Batch completed in ${batchDuration.toFixed(2)} minutes. Total added: ${totalAdded}, Failed: ${totalFailed}`);
      
      // Wait between batches - only if not the last batch
      if (i + BATCH_SIZE < channels.length) {
        const nextBatchTime = new Date(Date.now() + BATCH_DELAY_MS);
        logger.info(`Waiting until ${nextBatchTime.toLocaleTimeString()} before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        
        // Reload active accounts to get fresh status
        await loadActiveAccounts();
      }
    }
    
    logFile.write(`\n--- Channel Import Completed at ${new Date().toISOString()} ---\n`);
    logFile.write(`Total channels added: ${totalAdded}\n`);
    logFile.write(`Total channels failed: ${totalFailed}\n`);
    logFile.end();
    
    logger.info(`Channel import completed. Total added: ${totalAdded}, Failed: ${totalFailed}`);
    process.exit(0);
  } catch (error) {
    logger.error(`Error in batch processing: ${error.message}`, {
      context: { error: error.stack }
    });
    
    logFile.write(`\n--- Channel Import Failed at ${new Date().toISOString()} ---\n`);
    logFile.write(`Error: ${error.message}\n`);
    logFile.end();
    
    process.exit(1);
  }
}

async function getBestAccountForChannel() {
  try {
    // Get account with least number of channels
    const accountsByChannelCount = [...activeAccounts].sort((a, b) => 
      (a.current_channels_count || 0) - (b.current_channels_count || 0)
    );
    
    // Filter accounts that haven't reached daily join limit and max channel limit
    const eligibleAccounts = accountsByChannelCount.filter(account => 
      joinsByAccount[account._id] < SAFE_JOIN_LIMIT_PER_DAY &&
      (account.current_channels_count || 0) < MAX_CHANNELS_PER_ACCOUNT
    );
    
    if (eligibleAccounts.length === 0) {
      logger.warn('No eligible accounts available within daily join limits');
      return null;
    }
    
    // Return the account with fewest channels among eligible ones
    return eligibleAccounts[0];
  } catch (error) {
    logger.error(`Error getting best account: ${error.message}`);
    throw error;
  }
}

async function addChannel(channelUrl, account) {
  try {
    // Extract channel ID or username from URL
    const channelIdentifier = channelUrl.replace('https://t.me/', '');
    
    // Check if channel already exists
    const existingChannel = await Channel.findOne({ channel_id: channelUrl });
    
    if (existingChannel) {
      return {
        success: false,
        error: 'Channel already exists in database'
      };
    }
    
    // Get client for account
    const client = await getClient(account);
    
    // Try to join the channel
    try {
      // Resolve the channel entity
      const entity = await client.getEntity(channelIdentifier);
      
      // Get channel details
      const fullChannel = await client.invoke(
        new Api.channels.GetFullChannel({
          channel: entity
        })
      );
      
      const channelInfo = fullChannel.fullChat;
      const channel = fullChannel.chats[0];
      
      // Create or update channel in database
      const newChannel = await Channel.create({
        channel_id: channelUrl,
        name: channel.title || channelIdentifier,
        username: channel.username || '',
        joined_by_account_id: account._id,
        date_joined: new Date(),
        is_active: true,
        description: channelInfo.about || '',
        member_count: channel.participantsCount || 0,
        last_checked: new Date()
      });
      
      // Create assignment
      await AccountChannelAssignment.create({
        account_id: account._id,
        channel_id: newChannel._id,
        assigned_at: new Date(),
        status: 'active'
      });
      
      // Update account channel count
      await Account.findByIdAndUpdate(account._id, {
        $inc: { current_channels_count: 1 },
        last_active: new Date()
      });
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Error joining channel: ${error.message}`
      };
    }
  } catch (error) {
    logger.error(`Error in addChannel: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, stopping channel import...');
  isRunning = false;
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, stopping channel import...');
  isRunning = false;
}); 