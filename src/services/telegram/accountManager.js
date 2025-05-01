const Account = require('../../models/Account');
const AccountChannelAssignment = require('../../models/AccountChannelAssignment');
const { getClient, disconnectClient } = require('./client');
const logger = require('../../utils/logger');
const config = require('../../config/telegram');

/**
 * Initialize Telegram accounts
 * Only connects to accounts that have channels assigned
 */
const initializeAccounts = async () => {
  try {
    // Get accounts with assigned channels
    const assignments = await AccountChannelAssignment.find({})
      .populate('account_id');
    
    if (assignments.length === 0) {
      logger.info('No channel assignments found, skipping account initialization', {
        source: 'account-manager'
      });
      return;
    }
    
    // Get unique accounts that have channels assigned
    const accountsWithChannels = [...new Set(assignments.map(a => a.account_id))];
    
    logger.info(`Initializing ${accountsWithChannels.length} accounts with assigned channels`, {
      source: 'account-manager'
    });
    
    // Initialize each account
    for (const account of accountsWithChannels) {
      try {
        if (account.status !== 'active') {
          logger.warn(`Skipping initialization of inactive account ${account.phone_number}`, {
            source: 'account-manager'
          });
          continue;
        }
        
        // Test connection
        await getClient(account);
        
        logger.info(`Successfully initialized account ${account.phone_number}`, {
          source: 'account-manager'
        });
        
        // Update account status
        await Account.findByIdAndUpdate(account._id, {
          status: 'active',
          last_active: new Date()
        });
      } catch (error) {
        logger.error(`Failed to initialize account ${account.phone_number}: ${error.message}`, {
          source: 'account-manager',
          context: { error: error.stack }
        });
        
        // Update account status
        await Account.findByIdAndUpdate(account._id, {
          status: 'error',
          last_error: error.message,
          last_error_at: new Date()
        });
      }
    }
  } catch (error) {
    logger.error(`Error initializing accounts: ${error.message}`, {
      source: 'account-manager',
      context: { error: error.stack }
    });
  }
};

/**
 * Get the least loaded active account
 * @returns {Promise<Object>} - Least loaded account
 */
const getLeastLoadedAccount = async () => {
  try {
    // Get active accounts sorted by channel count
    const accounts = await Account.find({ status: 'active' })
      .sort({ current_channels_count: 1 })
      .limit(1);
    
    if (accounts.length === 0) {
      throw new Error('No active accounts available');
    }
    
    return accounts[0];
  } catch (error) {
    logger.error(`Error getting least loaded account: ${error.message}`, {
      source: 'account-manager',
      context: { error: error.stack }
    });
    throw error;
  }
};

/**
 * Update account channel count
 * @param {string} accountId - Account ID
 * @param {number} change - Change in channel count (1 or -1)
 */
const updateAccountChannelCount = async (accountId, change = 1) => {
  try {
    const account = await Account.findById(accountId);
    
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }
    
    const newCount = account.current_channels_count + change;
    
    await Account.findByIdAndUpdate(accountId, {
      current_channels_count: Math.max(0, newCount),
      last_active: new Date()
    });
    
    // If account has no more channels, disconnect the client
    if (newCount <= 0) {
      await disconnectClient(accountId.toString());
    }
    
    logger.info(`Updated channel count for account ${account.phone_number} to ${Math.max(0, newCount)}`, {
      source: 'account-manager'
    });
  } catch (error) {
    logger.error(`Error updating account channel count: ${error.message}`, {
      source: 'account-manager',
      context: { error: error.stack }
    });
  }
};

/**
 * Add a new Telegram account
 * @param {Object} accountData - Account data
 * @returns {Promise<Object>} - Created account
 */
const addAccount = async (accountData) => {
  try {
    const { username, phone_number, session_string, max_channels = 50 } = accountData;
    
    // Check if account already exists
    const existingAccount = await Account.findOne({ phone_number });
    
    if (existingAccount) {
      throw new Error(`Account with phone number ${phone_number} already exists`);
    }
    
    // Create account
    const account = await Account.create({
      username,
      phone_number,
      session_string,
      status: 'active',
      last_active: new Date(),
      max_channels,
      current_channels_count: 0
    });
    
    logger.info(`Added new account ${phone_number}`, {
      source: 'account-manager'
    });
    
    return account;
  } catch (error) {
    logger.error(`Error adding account: ${error.message}`, {
      source: 'account-manager',
      context: { error: error.stack }
    });
    throw error;
  }
};

/**
 * Check health of all accounts
 * Only checks accounts that have channels assigned
 */
const checkAccountsHealth = async () => {
  try {
    // Get accounts with assigned channels
    const assignments = await AccountChannelAssignment.find({})
      .populate('account_id');
    
    if (assignments.length === 0) {
      logger.info('No channel assignments found, skipping health check', {
        source: 'account-manager'
      });
      return;
    }
    
    // Get unique accounts that have channels assigned
    const accountIds = [...new Set(assignments.map(a => a.account_id._id.toString()))];
    const accounts = await Account.find({ _id: { $in: accountIds } });
    
    logger.info(`Checking health of ${accounts.length} accounts with assigned channels`, {
      source: 'account-manager'
    });
    
    for (const account of accounts) {
      try {
        // Test connection
        await getClient(account);
        
        // Update account status
        await Account.findByIdAndUpdate(account._id, {
          status: 'active',
          last_active: new Date()
        });
        
        logger.info(`Account ${account.phone_number} is healthy`, {
          source: 'account-manager'
        });
      } catch (error) {
        logger.error(`Account ${account.phone_number} health check failed: ${error.message}`, {
          source: 'account-manager',
          context: { error: error.stack }
        });
        
        // Update account status
        await Account.findByIdAndUpdate(account._id, {
          status: 'error',
          last_error: error.message,
          last_error_at: new Date()
        });
        
        // Disconnect client if it exists
        await disconnectClient(account._id.toString());
      }
    }
  } catch (error) {
    logger.error(`Error checking accounts health: ${error.message}`, {
      source: 'account-manager',
      context: { error: error.stack }
    });
  }
};

/**
 * Get the best account for a new channel
 * @returns {Promise<Object>} - Best account to use
 */
const getBestAccountForNewChannel = async () => {
  try {
    // First, try to find accounts that:
    // 1. Are active
    // 2. Have some channels but not too many (between 1 and 30)
    // 3. Haven't reached their daily join limit
    const accounts = await Account.find({
      status: 'active',
      current_channels_count: { $gt: 0, $lt: 30 }
    }).sort({ current_channels_count: 1 });
    
    if (accounts.length > 0) {
      logger.info(`Using existing active account ${accounts[0].phone_number} with ${accounts[0].current_channels_count} channels`, {
        source: 'account-manager'
      });
      return accounts[0];
    }
    
    // If no suitable active accounts with channels, get the least loaded account
    const leastLoadedAccounts = await Account.find({ status: 'active' })
      .sort({ current_channels_count: 1 })
      .limit(1);
    
    if (leastLoadedAccounts.length === 0) {
      throw new Error('No active accounts available');
    }
    
    logger.info(`Using least loaded account ${leastLoadedAccounts[0].phone_number} with ${leastLoadedAccounts[0].current_channels_count} channels`, {
      source: 'account-manager'
    });
    
    return leastLoadedAccounts[0];
  } catch (error) {
    logger.error(`Error getting best account for new channel: ${error.message}`, {
      source: 'account-manager',
      context: { error: error.stack }
    });
    throw error;
  }
};

module.exports = {
  initializeAccounts,
  getLeastLoadedAccount,
  getBestAccountForNewChannel,
  updateAccountChannelCount,
  addAccount,
  checkAccountsHealth
}; 