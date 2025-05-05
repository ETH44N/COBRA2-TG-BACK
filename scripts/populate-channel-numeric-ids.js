/**
 * Script to populate numeric_id field for all channels
 * This helps avoid repeated contacts.ResolveUsername calls
 */

// Set up path for environment variables from root directory
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Channel = require('../src/models/Channel');
const Account = require('../src/models/Account');
const { getClient } = require('../src/services/telegram/client');
const logger = require('../src/utils/logger');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Map to store account clients
const clientMap = new Map();

/**
 * Get the numeric ID for a channel using the Telegram API
 * @param {Object} channel - Channel document
 * @param {Object} account - Account document
 */
async function getChannelNumericId(channel, account) {
  try {
    // Get or create client for this account
    let client = clientMap.get(account._id.toString());
    if (!client) {
      client = await getClient(account);
      clientMap.set(account._id.toString(), client);
    }
    
    // Get entity from Telegram API
    const entity = await client.getEntity(channel.channel_id);
    
    // Extract numeric ID
    const numericId = entity.id?.toString();
    
    if (numericId) {
      // Update channel with numeric ID
      await Channel.findByIdAndUpdate(channel._id, { numeric_id: numericId });
      console.log(`✅ Updated channel: ${channel.channel_id} with numeric_id: ${numericId}`);
      return true;
    } else {
      console.error(`❌ Failed to get numeric ID for channel: ${channel.channel_id}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error getting numeric ID for channel ${channel.channel_id}:`, error.message);
    return false;
  }
}

/**
 * Process channels in batches to avoid rate limits
 * @param {Array} channels - List of channels to process
 * @param {Array} accounts - List of accounts to use
 * @param {Number} batchSize - Number of channels to process at once
 * @param {Number} delayMs - Delay between batches in milliseconds
 */
async function processChannelBatches(channels, accounts, batchSize = 5, delayMs = 5000) {
  // Filter out channels that already have a numeric_id
  const channelsToProcess = channels.filter(channel => !channel.numeric_id);
  console.log(`Found ${channelsToProcess.length} channels without numeric_id (out of ${channels.length} total)`);
  
  if (channelsToProcess.length === 0) {
    console.log('✅ All channels already have numeric IDs!');
    return;
  }
  
  // Calculate number of batches
  const numBatches = Math.ceil(channelsToProcess.length / batchSize);
  
  // Process batches sequentially
  let successCount = 0;
  let failCount = 0;
  let accountIndex = 0;
  
  for (let i = 0; i < numBatches; i++) {
    console.log(`\nProcessing batch ${i+1}/${numBatches}...`);
    
    // Get channels for this batch
    const batchChannels = channelsToProcess.slice(i * batchSize, (i + 1) * batchSize);
    
    // Process each channel in the batch concurrently
    const promises = batchChannels.map(async (channel) => {
      // Rotate accounts for each channel
      const account = accounts[accountIndex];
      accountIndex = (accountIndex + 1) % accounts.length;
      
      try {
        const success = await getChannelNumericId(channel, account);
        if (success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        console.error(`Error processing channel ${channel.channel_id}:`, error);
        failCount++;
      }
    });
    
    // Wait for all channels in this batch to be processed
    await Promise.all(promises);
    
    // Wait before processing next batch to avoid rate limits
    if (i < numBatches - 1) {
      console.log(`Waiting ${delayMs/1000} seconds before next batch...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  console.log(`\n✅ Done! Successfully updated ${successCount} channels, failed: ${failCount}`);
}

// Main function
async function main() {
  try {
    // Get all channels
    const channels = await Channel.find({}).lean();
    console.log(`Found ${channels.length} channels total`);
    
    // Get active accounts
    const accounts = await Account.find({ status: 'active' }).lean();
    if (accounts.length === 0) {
      console.error('No active accounts found!');
      process.exit(1);
    }
    console.log(`Found ${accounts.length} active accounts to use`);
    
    // Process channels
    await processChannelBatches(channels, accounts);
    
    // Disconnect from MongoDB
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
    process.exit(0);
  } catch (error) {
    console.error('Error in main function:', error);
    process.exit(1);
  }
}

// Start the script
main(); 