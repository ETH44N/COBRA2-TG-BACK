/**
 * Telegram API Diagnostic Script
 * 
 * This script thoroughly tests the Telegram API configuration and functionality.
 * It verifies the environment setup, tests the connection, and validates the
 * configured accounts and channels.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');

// Check if running in the correct directory
const isInCorrectDir = fs.existsSync(path.join(__dirname, '../../package.json'));
if (!isInCorrectDir) {
  console.error('\n⛔ ERROR: This script must be run from the project root directory!');
  console.error('Example: node src/scripts/diagnose_telegram.js\n');
  process.exit(1);
}

// Set up simple logging
const log = {
  info: (msg) => console.log(`ℹ️ ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.log(`⚠️ ${msg}`),
  error: (msg) => console.log(`❌ ${msg}`),
  divider: () => console.log('\n' + '='.repeat(60) + '\n'),
  section: (title) => {
    console.log('\n' + '-'.repeat(60));
    console.log(`| ${title}`);
    console.log('-'.repeat(60));
  }
};

async function main() {
  try {
    log.divider();
    log.info('TELEGRAM MONITORING SYSTEM DIAGNOSTICS');
    log.divider();
    
    // Step 1: Check environment variables
    checkEnvironmentVariables();
    
    // Step 2: Check database connection
    await checkDatabaseConnection();
    
    // Step 3: Check Telegram API credentials
    checkTelegramCredentials();
    
    // Step 4: Check Telegram accounts in database
    await checkTelegramAccounts();
    
    // Step 5: Test Telegram connection
    await testTelegramConnection();
    
    // Step 6: Verify channel access
    await verifyChannelAccess();
    
    // Step 7: Check message polling
    await testMessagePolling();
    
    log.divider();
    log.success('DIAGNOSTICS COMPLETE');
    log.divider();
    
    // Cleanup
    await closeConnections();
    process.exit(0);
  } catch (error) {
    log.divider();
    log.error(`DIAGNOSTIC FAILED: ${error.message}`);
    console.error(error);
    log.divider();
    
    try {
      await closeConnections();
    } catch (err) {
      // Ignore
    }
    
    process.exit(1);
  }
}

// Global variables
let Account;
let Channel;
let Message;
let dbConnection;
let telegramClient;

/**
 * Step 1: Check Environment Variables
 */
function checkEnvironmentVariables() {
  log.section('1. CHECKING ENVIRONMENT VARIABLES');
  
  // Check essential variables
  const requiredVars = [
    'MONGODB_URI',
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH'
  ];
  
  let missingVars = [];
  
  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      missingVars.push(varName);
      log.error(`Missing environment variable: ${varName}`);
    } else {
      if (varName === 'TELEGRAM_API_HASH') {
        const value = process.env[varName];
        log.success(`${varName} is set: ${value.substring(0, 4)}...${value.substring(value.length - 4)}`);
      } else if (varName === 'MONGODB_URI') {
        const value = process.env[varName];
        const maskedUri = value.replace(/(mongodb(\+srv)?:\/\/)([^:]+):([^@]+)@/, '$1****:****@');
        log.success(`${varName} is set: ${maskedUri}`);
      } else {
        log.success(`${varName} is set: ${process.env[varName]}`);
      }
    }
  }
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  // Check for parsing issues with API_ID
  const apiId = process.env.TELEGRAM_API_ID;
  if (apiId && isNaN(parseInt(apiId, 10))) {
    throw new Error('TELEGRAM_API_ID must be a valid number');
  }
  
  log.success('All required environment variables are set');
}

/**
 * Step 2: Check Database Connection
 */
async function checkDatabaseConnection() {
  log.section('2. CHECKING DATABASE CONNECTION');
  
  try {
    log.info(`Connecting to MongoDB: ${process.env.MONGODB_URI.replace(/(mongodb(\+srv)?:\/\/)([^:]+):([^@]+)@/, '$1****:****@')}`);
    
    dbConnection = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    log.success('Successfully connected to MongoDB');
    
    // Create model references
    setupModels();
    
    // Check if collections exist
    const collections = await mongoose.connection.db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    log.info(`Available collections: ${collectionNames.join(', ')}`);
    
    const requiredCollections = ['accounts', 'channels', 'messages'];
    for (const collection of requiredCollections) {
      if (!collectionNames.includes(collection)) {
        log.warn(`Collection '${collection}' is missing!`);
      } else {
        log.success(`Collection '${collection}' exists`);
      }
    }
  } catch (error) {
    throw new Error(`Failed to connect to MongoDB: ${error.message}`);
  }
}

/**
 * Set up Mongoose models
 */
function setupModels() {
  // Define schemas
  const accountSchema = new mongoose.Schema({
    phone_number: String,
    session_string: String,
    status: String
  });
  
  const channelSchema = new mongoose.Schema({
    channel_id: String,
    name: String,
    is_active: Boolean
  });
  
  const messageSchema = new mongoose.Schema({
    channel_id: mongoose.Schema.Types.ObjectId,
    message_id: Number,
    content: String,
    message_type: String,
    created_at: Date
  });
  
  // Create models
  Account = mongoose.model('Account', accountSchema);
  Channel = mongoose.model('Channel', channelSchema);
  Message = mongoose.model('Message', messageSchema);
}

/**
 * Step 3: Check Telegram Credentials
 */
function checkTelegramCredentials() {
  log.section('3. CHECKING TELEGRAM API CREDENTIALS');
  
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  
  if (!apiId || !apiHash) {
    throw new Error('Telegram API credentials not found');
  }
  
  // Validate API ID format
  const parsedApiId = parseInt(apiId, 10);
  if (isNaN(parsedApiId)) {
    throw new Error('TELEGRAM_API_ID must be a valid number');
  }
  
  log.success(`API ID is valid: ${parsedApiId}`);
  
  // Validate API Hash format (should be 32 hexadecimal characters)
  const apiHashRegex = /^[a-f0-9]{32}$/i;
  if (!apiHashRegex.test(apiHash)) {
    log.warn('TELEGRAM_API_HASH format may be invalid - should be 32 hexadecimal characters');
  } else {
    log.success(`API Hash is valid: ${apiHash.substring(0, 4)}...${apiHash.substring(apiHash.length - 4)}`);
  }
}

/**
 * Step 4: Check Telegram Accounts
 */
async function checkTelegramAccounts() {
  log.section('4. CHECKING TELEGRAM ACCOUNTS');
  
  try {
    // Get all accounts
    const accounts = await Account.find({});
    
    if (accounts.length === 0) {
      throw new Error('No Telegram accounts found in the database');
    }
    
    log.success(`Found ${accounts.length} account(s) in the database`);
    
    // Check each account
    for (const account of accounts) {
      const id = account._id ? account._id.toString() : 'unknown';
      const phone = account.phone_number || 'N/A';
      const status = account.status || 'unknown';
      
      log.info(`Account ${id} - Phone: ${phone}, Status: ${status}`);
      
      // Check for valid session string
      if (!account.session_string) {
        log.warn(`Account ${id} does not have a session string!`);
      } else {
        log.success(`Account ${id} has a session string`);
      }
    }
    
    // Count active accounts
    const activeAccounts = accounts.filter(a => a.status === 'active');
    if (activeAccounts.length === 0) {
      log.warn('No active accounts found - monitoring will not work!');
    } else {
      log.success(`${activeAccounts.length} active account(s) available for monitoring`);
    }
  } catch (error) {
    throw new Error(`Failed to check Telegram accounts: ${error.message}`);
  }
}

/**
 * Step 5: Test Telegram Connection
 */
async function testTelegramConnection() {
  log.section('5. TESTING TELEGRAM CONNECTION');
  
  try {
    // Get first active account
    const account = await Account.findOne({ status: 'active' });
    
    if (!account) {
      throw new Error('No active accounts found for testing connection');
    }
    
    const id = account._id ? account._id.toString() : 'unknown';
    log.info(`Testing connection with account ${id}`);
    
    if (!account.session_string) {
      throw new Error('Account does not have a session string');
    }
    
    // Create client
    const session = new StringSession(account.session_string);
    telegramClient = new TelegramClient(
      session,
      parseInt(process.env.TELEGRAM_API_ID, 10),
      process.env.TELEGRAM_API_HASH,
      {
        connectionRetries: 3,
        retryDelay: 1000
      }
    );
    
    log.info('Connecting to Telegram...');
    await telegramClient.connect();
    
    log.success('Successfully connected to Telegram');
    
    // Get account info
    log.info('Getting account information...');
    const me = await telegramClient.getMe();
    
    log.success(`Connected as: ${me.username || me.firstName || me.phone}`);
    log.info(`User ID: ${me.id}`);
    log.info(`First Name: ${me.firstName || 'N/A'}`);
    log.info(`Username: ${me.username || 'N/A'}`);
  } catch (error) {
    throw new Error(`Failed to connect to Telegram: ${error.message}`);
  }
}

/**
 * Step 6: Verify Channel Access
 */
async function verifyChannelAccess() {
  log.section('6. VERIFYING CHANNEL ACCESS');
  
  try {
    // Get all active channels
    const channels = await Channel.find({ is_active: true });
    
    if (channels.length === 0) {
      log.warn('No active channels found in the database');
      return;
    }
    
    log.success(`Found ${channels.length} active channel(s) in the database`);
    
    // Check access to each channel
    for (const channel of channels) {
      const id = channel._id ? channel._id.toString() : 'unknown';
      const name = channel.name || 'Unnamed';
      const channelId = channel.channel_id || 'N/A';
      
      log.info(`Checking channel ${id} - Name: ${name}, ID: ${channelId}`);
      
      try {
        // Try to get the channel entity
        const entity = await telegramClient.getEntity(channelId);
        
        if (!entity) {
          log.warn(`Could not get entity for channel ${channelId}`);
          continue;
        }
        
        log.success(`Successfully accessed channel: ${entity.title || entity.username || entity.id}`);
        
        // Count messages for this channel
        const messageCount = await Message.countDocuments({ channel_id: channel._id });
        log.info(`Channel has ${messageCount} messages in the database`);
        
        // Test getting messages
        log.info('Testing message retrieval...');
        const messages = await telegramClient.getMessages(entity, { limit: 1 });
        
        if (messages && messages.length > 0) {
          const msg = messages[0];
          log.success(`Successfully retrieved message #${msg.id}`);
          log.info(`Message date: ${new Date(msg.date * 1000).toISOString()}`);
          log.info(`Message text: ${msg.text ? msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : '') : 'No text'}`);
        } else {
          log.warn('No messages could be retrieved from this channel');
        }
      } catch (error) {
        log.error(`Failed to access channel ${channelId}: ${error.message}`);
      }
    }
  } catch (error) {
    throw new Error(`Failed to verify channel access: ${error.message}`);
  }
}

/**
 * Step 7: Test Message Polling
 */
async function testMessagePolling() {
  log.section('7. TESTING MESSAGE POLLING');
  
  try {
    // Get first active channel
    const channel = await Channel.findOne({ is_active: true });
    
    if (!channel) {
      log.warn('No active channels found for testing polling');
      return;
    }
    
    const id = channel._id ? channel._id.toString() : 'unknown';
    const name = channel.name || 'Unnamed';
    const channelId = channel.channel_id || 'N/A';
    
    log.info(`Testing polling with channel ${id} - Name: ${name}, ID: ${channelId}`);
    
    try {
      // Get the channel entity
      const entity = await telegramClient.getEntity(channelId);
      
      if (!entity) {
        log.warn(`Could not get entity for channel ${channelId}`);
        return;
      }
      
      // Test getting messages
      log.info('Polling for latest messages...');
      const messages = await telegramClient.getMessages(entity, { limit: 5 });
      
      if (!messages || messages.length === 0) {
        log.warn('No messages found during polling test');
        return;
      }
      
      log.success(`Retrieved ${messages.length} messages during polling test`);
      
      // Process messages
      for (const message of messages) {
        if (!message || !message.id) continue;
        
        log.info(`Processing message #${message.id}`);
        
        // Extract message data
        const data = extractMessageData(message);
        
        log.info(`Message text: ${data.text ? data.text.substring(0, 50) + (data.text.length > 50 ? '...' : '') : 'No text'}`);
        log.info(`Has media: ${data.hasMedia ? 'Yes' : 'No'}`);
        if (data.hasMedia) {
          log.info(`Media type: ${data.mediaType}`);
        }
        
        // Check if message exists in database
        const existingMessage = await Message.findOne({
          channel_id: channel._id,
          message_id: message.id
        });
        
        if (existingMessage) {
          log.info(`Message #${message.id} already exists in the database`);
        } else {
          log.success(`Message #${message.id} is new and would be saved`);
        }
      }
      
      log.success('Message polling test completed successfully');
    } catch (error) {
      log.error(`Failed to test polling: ${error.message}`);
    }
  } catch (error) {
    throw new Error(`Failed to test message polling: ${error.message}`);
  }
}

/**
 * Extract message data safely
 */
function extractMessageData(message) {
  if (!message || typeof message !== 'object') {
    return {
      id: null,
      text: '',
      date: new Date(),
      hasMedia: false,
      mediaType: null,
      chat: { id: null, title: null }
    };
  }

  try {
    // Extract basic message properties
    const data = {
      id: message.id || null,
      text: message.text || message.message || '',
      date: message.date ? new Date(message.date * 1000) : new Date(),
      hasMedia: false,
      mediaType: null,
      chat: {
        id: message.chatId || (message.chat ? message.chat.id : null),
        title: message.chat ? (message.chat.title || message.chat.username || null) : null
      }
    };

    // Check for media
    if (message.media) {
      data.hasMedia = true;
      // Determine media type
      if (message.media.photo) {
        data.mediaType = 'photo';
      } else if (message.media.document) {
        data.mediaType = 'document';
        if (message.media.document.mimeType && message.media.document.mimeType.startsWith('video/')) {
          data.mediaType = 'video';
        }
      } else if (message.media.webpage) {
        data.mediaType = 'webpage';
        // Extract additional text from webpage if available
        if (message.media.webpage.description) {
          data.text += '\n' + message.media.webpage.description;
        }
      }
    }

    return data;
  } catch (error) {
    console.error('Error extracting message data:', error);
    return {
      id: message.id || null,
      text: 'Error extracting message content',
      date: new Date(),
      hasMedia: false,
      mediaType: null,
      chat: { id: null, title: null }
    };
  }
}

/**
 * Clean up connections
 */
async function closeConnections() {
  log.info('Cleaning up connections...');
  
  if (telegramClient && telegramClient.connected) {
    try {
      await telegramClient.disconnect();
      log.info('Disconnected from Telegram');
    } catch (error) {
      log.warn(`Failed to disconnect from Telegram: ${error.message}`);
    }
  }
  
  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.connection.close();
      log.info('Disconnected from MongoDB');
    } catch (error) {
      log.warn(`Failed to disconnect from MongoDB: ${error.message}`);
    }
  }
}

// Run the diagnostic
main(); 