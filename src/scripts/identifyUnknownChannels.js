require('dotenv').config();
const mongoose = require('mongoose');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { writeFileSync, existsSync, readFileSync } = require('fs');
const path = require('path');
const Account = require('../models/Account');
const Channel = require('../models/Channel');
const connectDB = require('../config/database');
const logger = require('../utils/logger');

// The path to store our channel mappings
const CHANNEL_MAPPING_PATH = path.join(__dirname, '../../data/channel-mappings.json');

/**
 * Load existing channel mappings from file
 */
function loadExistingMappings() {
  try {
    if (existsSync(CHANNEL_MAPPING_PATH)) {
      const data = readFileSync(CHANNEL_MAPPING_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading existing mappings:', error.message);
  }
  
  return { channels: {}, ignored: [] };
}

/**
 * Save channel mappings to file
 */
function saveMappings(mappings) {
  try {
    // Ensure the directory exists
    const dir = path.dirname(CHANNEL_MAPPING_PATH);
    if (!existsSync(dir)) {
      require('fs').mkdirSync(dir, { recursive: true });
    }
    
    writeFileSync(CHANNEL_MAPPING_PATH, JSON.stringify(mappings, null, 2), 'utf8');
    console.log(`Saved channel mappings to ${CHANNEL_MAPPING_PATH}`);
  } catch (error) {
    console.error('Error saving mappings:', error.message);
  }
}

/**
 * Connect to Telegram and identify unknown channel IDs
 */
async function identifyUnknownChannels(channelIds = []) {
  try {
    await connectDB();
    
    // If no channel IDs provided, try to extract them from logs
    if (!channelIds || channelIds.length === 0) {
      console.log('No channel IDs provided. Checking the database for monitored channels first...');
      
      // Get all known numeric IDs from the database
      const knownChannels = await Channel.find({ numeric_id: { $exists: true, $ne: null } });
      const knownNumericIds = new Set(knownChannels.map(c => c.numeric_id.toString()));
      
      console.log(`Found ${knownNumericIds.size} channels with numeric IDs in the database.`);
      
      // Load existing mappings
      const mappings = loadExistingMappings();
      const knownMappedIds = new Set(Object.keys(mappings.channels));
      const ignoredIds = new Set(mappings.ignored);
      
      console.log(`Found ${knownMappedIds.size} mapped channels and ${ignoredIds.size} ignored channels in the mapping file.`);
      
      // If no channel IDs provided, ask user to input them
      console.log('\nPlease enter numeric channel IDs to identify (comma-separated):');
      const input = await new Promise(resolve => {
        process.stdin.once('data', data => {
          resolve(data.toString().trim());
        });
      });
      
      channelIds = input.split(',').map(id => id.trim()).filter(id => id);
    }
    
    if (channelIds.length === 0) {
      console.log('No channel IDs to identify. Exiting.');
      process.exit(0);
    }
    
    console.log(`Attempting to identify ${channelIds.length} channel IDs...`);
    
    // Load existing mappings
    const mappings = loadExistingMappings();
    
    // Find an active account to use
    const account = await Account.findOne({ status: 'active', isBanned: { $ne: true } });
    if (!account) {
      throw new Error('No active account found to use for channel identification');
    }
    
    console.log(`Using account ${account.phone_number} to identify channels...`);
    
    // Create a Telegram client
    const session = new StringSession(account.session_string);
    const client = new TelegramClient(
      session,
      parseInt(process.env.TELEGRAM_API_ID),
      process.env.TELEGRAM_API_HASH,
      {
        connectionRetries: 5,
        baseLogger: console
      }
    );
    
    await client.connect();
    
    if (!client.connected) {
      throw new Error('Failed to connect to Telegram');
    }
    
    console.log('Connected to Telegram. Identifying channels...');
    
    // Identify each channel
    for (const channelId of channelIds) {
      try {
        // Skip if already known
        if (mappings.channels[channelId]) {
          console.log(`Channel ${channelId} already mapped to "${mappings.channels[channelId].name}"`);
          continue;
        }
        
        // Skip if intentionally ignored
        if (mappings.ignored.includes(channelId)) {
          console.log(`Channel ${channelId} is in the ignore list. Skipping.`);
          continue;
        }
        
        // Get the entity
        const entity = await client.getEntity(BigInt(channelId));
        
        if (entity) {
          const info = {
            name: entity.title || entity.username || 'Unknown',
            username: entity.username || null,
            type: entity.className,
            participantsCount: entity.participantsCount || null,
            identified_at: new Date().toISOString()
          };
          
          mappings.channels[channelId] = info;
          
          console.log(`✅ Identified ${channelId} as "${info.name}" (${info.type})`);
          
          // Save after each successful identification
          saveMappings(mappings);
          
          // Ask if user wants to monitor this channel
          console.log(`Do you want to add "${info.name}" to your monitored channels? (y/n/i)`);
          console.log('- y: Yes, add to monitored channels');
          console.log('- n: No, just keep the mapping');
          console.log('- i: Ignore this channel in future');
          
          const answer = await new Promise(resolve => {
            process.stdin.once('data', data => {
              resolve(data.toString().trim().toLowerCase());
            });
          });
          
          if (answer === 'y') {
            // Check if this channel already exists by username
            let existingChannel = null;
            
            if (info.username) {
              existingChannel = await Channel.findOne({ 
                $or: [
                  { username: info.username },
                  { channel_id: info.username }
                ] 
              });
            }
            
            if (existingChannel) {
              // Update existing channel
              await Channel.updateOne(
                { _id: existingChannel._id },
                { 
                  numeric_id: channelId,
                  name: info.name
                }
              );
              console.log(`Updated existing channel ${existingChannel.channel_id} with numeric ID ${channelId}`);
            } else {
              // Create new channel
              const newChannel = await Channel.create({
                channel_id: info.username || channelId,
                name: info.name,
                username: info.username,
                numeric_id: channelId,
                is_active: false
              });
              
              console.log(`Created new channel entry: ${newChannel.channel_id} with numeric ID ${channelId}`);
            }
          } else if (answer === 'i') {
            // Add to ignore list
            mappings.ignored.push(channelId);
            console.log(`Added ${channelId} to ignore list`);
            saveMappings(mappings);
          }
          
        } else {
          console.log(`❌ Could not identify channel ${channelId}`);
        }
      } catch (error) {
        console.error(`Error identifying channel ${channelId}: ${error.message}`);
      }
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Save final mappings
    saveMappings(mappings);
    
    console.log('Channel identification completed!');
    
    // Disconnect the client
    await client.disconnect();
    
    return mappings;
  } catch (error) {
    console.error(`Error in identifyUnknownChannels: ${error.message}`);
    throw error;
  } finally {
    // Close database connection
    await mongoose.connection.close();
  }
}

// Run the script if called directly
if (require.main === module) {
  // Get channel IDs from command line arguments
  const channelIds = process.argv.slice(2);
  
  // Execute the function
  identifyUnknownChannels(channelIds)
    .then(() => {
      console.log('Script completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
} else {
  // Export for use as a module
  module.exports = identifyUnknownChannels;
} 