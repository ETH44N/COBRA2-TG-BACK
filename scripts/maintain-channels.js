require('dotenv').config();
const mongoose = require('mongoose');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const logger = require('../src/utils/logger');
const Account = require('../src/models/Account');
const Channel = require('../src/models/Channel');
const AccountChannelAssignment = require('../src/models/AccountChannelAssignment');

// Configuration
const TELEGRAM_API_ID = 16505588;
const TELEGRAM_API_HASH = "8627549376532003f12e386841814511";
const CHECK_INTERVAL_MS = 3600000; // Check every hour
const MAX_CHANNELS_PER_ACCOUNT = parseInt(process.env.MAX_CHANNELS_PER_ACCOUNT || '40', 10);
const CHANNEL_REASSIGNMENT_DELAY_MS = 120000; // 2 minutes between channel reassignments

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('Connected to MongoDB for channel maintenance');
  startMaintenance();
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

let isRunning = true;

async function startMaintenance() {
  logger.info('Starting channel maintenance service');
  
  while (isRunning) {
    try {
      logger.info('Running maintenance check...');
      
      // Check for banned accounts
      await checkAccountsHealth();
      
      // Check for channels without assignments
      await reassignOrphanedChannels();
      
      // Wait for the next check interval
      logger.info(`Maintenance check completed. Next check in ${CHECK_INTERVAL_MS / 60000} minutes.`);
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
    } catch (error) {
      logger.error(`Error in maintenance cycle: ${error.message}`, {
        context: { error: error.stack }
      });
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  }
}

async function checkAccountsHealth() {
  try {
    // Get all active accounts
    const accounts = await Account.find({ 
      status: 'active'
    });
    
    logger.info(`Checking health of ${accounts.length} active accounts`);
    
    for (const account of accounts) {
      try {
        // Skip accounts that are already marked as banned
        if (account.isBanned) {
          continue;
        }
        
        // Check if the account is still active by attempting to connect
        const isActive = await checkAccountConnection(account);
        
        if (!isActive) {
          logger.warn(`Account ${account.phone_number} appears to be banned or limited`);
          
          // Mark account as banned
          await Account.findByIdAndUpdate(account._id, {
            isBanned: true,
            banDate: new Date(),
            status: 'banned'
          });
          
          // Reassign its channels
          await reassignAccountChannels(account._id);
        } else {
          logger.info(`Account ${account.phone_number} is healthy`);
        }
      } catch (error) {
        logger.error(`Error checking account ${account.phone_number}: ${error.message}`, {
          context: { error: error.stack }
        });
      }
    }
  } catch (error) {
    logger.error(`Error in account health check: ${error.message}`, {
      context: { error: error.stack }
    });
  }
}

async function checkAccountConnection(account) {
  try {
    const session = new StringSession(account.session_string);
    
    const client = new TelegramClient(
      session,
      TELEGRAM_API_ID,
      TELEGRAM_API_HASH,
      {
        connectionRetries: 2,
        useWSS: true,
        timeout: 30000,
      }
    );
    
    // Connect with timeout
    await client.connect();
    
    // Check if the client is authorized
    const isAuthorized = await client.isUserAuthorized();
    
    // Disconnect client
    await client.disconnect();
    
    return isAuthorized;
  } catch (error) {
    logger.error(`Error testing account connection: ${error.message}`);
    return false;
  }
}

async function reassignAccountChannels(accountId) {
  try {
    // Get assignments for the banned account
    const assignments = await AccountChannelAssignment.find({
      account_id: accountId,
      status: 'active'
    }).populate('channel_id');
    
    logger.info(`Found ${assignments.length} channels to reassign from banned account ${accountId}`);
    
    // Reassign each channel to a different account
    for (const assignment of assignments) {
      try {
        // Get best account for the channel
        const newAccount = await getBestAccountForChannel();
        
        if (!newAccount) {
          logger.warn(`No suitable account available for reassigning channel ${assignment.channel_id.name}`);
          continue;
        }
        
        logger.info(`Reassigning channel ${assignment.channel_id.name} from account ${accountId} to ${newAccount._id}`);
        
        // Mark old assignment as reassigned
        await AccountChannelAssignment.findByIdAndUpdate(assignment._id, {
          status: 'reassigned'
        });
        
        // Create new assignment
        await AccountChannelAssignment.create({
          account_id: newAccount._id,
          channel_id: assignment.channel_id._id,
          assigned_at: new Date(),
          status: 'active'
        });
        
        // Update channel
        await Channel.findByIdAndUpdate(assignment.channel_id._id, {
          joined_by_account_id: newAccount._id,
          date_joined: new Date()
        });
        
        // Update account channel count
        await Account.findByIdAndUpdate(newAccount._id, {
          $inc: { current_channels_count: 1 }
        });
        
        // Delay between reassignments
        await new Promise(resolve => setTimeout(resolve, CHANNEL_REASSIGNMENT_DELAY_MS));
      } catch (error) {
        logger.error(`Error reassigning channel ${assignment.channel_id._id}: ${error.message}`, {
          context: { error: error.stack }
        });
      }
    }
    
    // Update banned account's channel count
    await Account.findByIdAndUpdate(accountId, {
      current_channels_count: 0
    });
  } catch (error) {
    logger.error(`Error reassigning channels from account ${accountId}: ${error.message}`, {
      context: { error: error.stack }
    });
  }
}

async function reassignOrphanedChannels() {
  try {
    // Find channels without active assignments
    const orphanedChannels = await Channel.find({ is_active: true });
    const validChannels = [];
    
    for (const channel of orphanedChannels) {
      const hasActiveAssignment = await AccountChannelAssignment.exists({
        channel_id: channel._id,
        status: 'active'
      });
      
      if (!hasActiveAssignment) {
        validChannels.push(channel);
      }
    }
    
    logger.info(`Found ${validChannels.length} orphaned channels to reassign`);
    
    // Reassign each orphaned channel
    for (const channel of validChannels) {
      try {
        // Get best account for the channel
        const newAccount = await getBestAccountForChannel();
        
        if (!newAccount) {
          logger.warn(`No suitable account available for orphaned channel ${channel.name}`);
          continue;
        }
        
        logger.info(`Assigning orphaned channel ${channel.name} to account ${newAccount._id}`);
        
        // Create new assignment
        await AccountChannelAssignment.create({
          account_id: newAccount._id,
          channel_id: channel._id,
          assigned_at: new Date(),
          status: 'active'
        });
        
        // Update channel
        await Channel.findByIdAndUpdate(channel._id, {
          joined_by_account_id: newAccount._id,
          date_joined: new Date()
        });
        
        // Update account channel count
        await Account.findByIdAndUpdate(newAccount._id, {
          $inc: { current_channels_count: 1 }
        });
        
        // Delay between reassignments
        await new Promise(resolve => setTimeout(resolve, CHANNEL_REASSIGNMENT_DELAY_MS));
      } catch (error) {
        logger.error(`Error reassigning orphaned channel ${channel._id}: ${error.message}`, {
          context: { error: error.stack }
        });
      }
    }
  } catch (error) {
    logger.error(`Error reassigning orphaned channels: ${error.message}`, {
      context: { error: error.stack }
    });
  }
}

async function getBestAccountForChannel() {
  try {
    // Get accounts sorted by channel count
    const accounts = await Account.find({
      status: 'active',
      isBanned: { $ne: true }
    }).sort({ current_channels_count: 1 });
    
    if (accounts.length === 0) {
      return null;
    }
    
    // Get the least loaded account that hasn't reached the maximum
    for (const account of accounts) {
      if ((account.current_channels_count || 0) < MAX_CHANNELS_PER_ACCOUNT) {
        return account;
      }
    }
    
    return null; // No suitable account found
  } catch (error) {
    logger.error(`Error finding best account: ${error.message}`);
    return null;
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, stopping maintenance...');
  isRunning = false;
  
  // Allow time for current operations to complete
  setTimeout(() => {
    logger.info('Exiting maintenance service');
    process.exit(0);
  }, 5000);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, stopping maintenance...');
  isRunning = false;
  
  // Allow time for current operations to complete
  setTimeout(() => {
    logger.info('Exiting maintenance service');
    process.exit(0);
  }, 5000);
}); 