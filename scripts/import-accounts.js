require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const mongoose = require('mongoose');
const Account = require('../src/models/Account');
const logger = require('../src/utils/logger');

// Configuration
const ACCOUNTS_FILE = path.join(__dirname, '../COBRA.telegramAccounts.json');
const BATCH_SIZE = 3; // Reduced batch size to avoid rate limiting
const CONNECT_TIMEOUT = 45000; // Increased timeout to 45 seconds

// Telegram API credentials - using the ones from your working script
const API_ID = 16505588;
const API_HASH = "8627549376532003f12e386841814511";

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('Connected to MongoDB for account import');
  importAccounts();
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Main import function
async function importAccounts() {
  try {
    // Read accounts from JSON file
    const rawData = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const accounts = JSON.parse(rawData);
    
    logger.info(`Found ${accounts.length} accounts in the JSON file`);
    
    // Results tracking
    const results = {
      total: accounts.length,
      success: 0,
      failed: 0,
      alreadyExists: 0,
      details: []
    };
    
    // Process accounts in batches to avoid overwhelming Telegram servers
    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);
      
      logger.info(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(accounts.length/BATCH_SIZE)}`);
      
      // Process batch sequentially to avoid rate limiting
      for (const account of batch) {
        const result = await processAccount(account);
        results[result.status]++;
        results.details.push(result);
      }
      
      // Wait between batches to avoid rate limiting
      if (i + BATCH_SIZE < accounts.length) {
        logger.info('Waiting 10 seconds before next batch...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
    
    // Generate report
    generateReport(results);
    
    logger.info('Account import completed');
    process.exit(0);
  } catch (error) {
    logger.error(`Error importing accounts: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
}

// Process a single account
async function processAccount(account) {
  const phoneNumber = account.phoneNumber;
  const sessionString = account.sessionString;
  const name = account.name || '';
  
  logger.info(`Processing account: ${phoneNumber}`);
  
  try {
    // Check if account already exists in database
    const existingAccount = await Account.findOne({ phone_number: phoneNumber });
    
    if (existingAccount) {
      logger.info(`Account ${phoneNumber} already exists in database`);
      return {
        phone_number: phoneNumber,
        status: 'alreadyExists',
        message: 'Account already exists in database'
      };
    }
    
    // Test the account by connecting to Telegram
    const validationResult = await testTelegramAccount(sessionString);
    
    if (!validationResult.isValid) {
      logger.warn(`Account ${phoneNumber} failed validation: ${validationResult.error}`);
      return {
        phone_number: phoneNumber,
        status: 'failed',
        message: validationResult.error || 'Failed to connect to Telegram'
      };
    }
    
    // Account is valid, save to database
    const newAccount = await Account.create({
      username: validationResult.username || name,
      phone_number: phoneNumber,
      session_string: sessionString,
      status: 'active',
      last_active: new Date(),
      max_channels: 50,
      current_channels_count: 0
    });
    
    logger.info(`Successfully imported account: ${phoneNumber} (${validationResult.username})`);
    
    return {
      phone_number: phoneNumber,
      username: validationResult.username,
      status: 'success',
      account_id: newAccount._id,
      message: 'Account imported successfully'
    };
    
  } catch (error) {
    logger.error(`Error processing account ${phoneNumber}: ${error.message}`, {
      context: { error: error.stack }
    });
    
    return {
      phone_number: phoneNumber,
      status: 'failed',
      message: error.message
    };
  }
}

// Test if a Telegram account is valid by attempting to connect
async function testTelegramAccount(sessionString) {
  try {
    const session = new StringSession(sessionString);
    
    const client = new TelegramClient(
      session,
      API_ID,
      API_HASH,
      {
        connectionRetries: 3,
        useWSS: true,
        timeout: CONNECT_TIMEOUT,
      }
    );
    
    // Connect with timeout
    await client.connect();
    
    // Check if the client is authorized
    const isAuthorized = await client.isUserAuthorized();
    
    if (!isAuthorized) {
      await client.disconnect();
      return { 
        isValid: false, 
        error: 'Account not authorized' 
      };
    }
    
    // Get account info
    const me = await client.getMe();
    
    // Disconnect client
    await client.disconnect();
    
    return { 
      isValid: true,
      username: me.username || me.firstName || 'Unknown'
    };
  } catch (error) {
    logger.error(`Error testing Telegram account: ${error.message}`);
    return { 
      isValid: false, 
      error: error.message 
    };
  }
}

// Generate a report of the import results
function generateReport(results) {
  const reportPath = path.join(__dirname, '../account-import-report.json');
  
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total: results.total,
      successful: results.success,
      failed: results.failed,
      alreadyExists: results.alreadyExists
    },
    accounts: results.details
  };
  
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  logger.info(`
=== ACCOUNT IMPORT REPORT ===
Total accounts processed: ${results.total}
Successfully imported: ${results.success}
Failed to import: ${results.failed}
Already in database: ${results.alreadyExists}
Detailed report saved to: ${reportPath}
============================
  `);
} 