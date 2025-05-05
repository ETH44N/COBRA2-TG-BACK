require('dotenv').config();
const mongoose = require('mongoose');
const { writeFileSync, existsSync, readFileSync } = require('fs');
const path = require('path');
const Account = require('../models/Account');
const Channel = require('../models/Channel');
const connectDB = require('../config/database');
const logger = require('../utils/logger');
const { getClient } = require('../services/telegram/client');

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
  
  return { channels: {}, ignored: [], users: {}, chats: {} };
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
    console.log(`Saved mappings to ${CHANNEL_MAPPING_PATH}`);
  } catch (error) {
    console.error('Error saving mappings:', error.message);
  }
}

/**
 * Map active channels for all accounts
 */
async function mapActiveChannels() {
  try {
    await connectDB();
    
    // Load existing mappings
    const mappings = loadExistingMappings();
    let updated = 0;
    
    // Get all active accounts
    const accounts = await Account.find({ status: 'active', isBanned: { $ne: true } });
    console.log(`Found ${accounts.length} active accounts to check.`);
    
    for (const account of accounts) {
      console.log(`Connecting to account ${account.phone_number}...`);
      
      try {
        // Connect to Telegram with this account
        const client = await getClient(account);
        
        if (!client.connected) {
          console.log(`Account ${account.phone_number} is not connected. Skipping.`);
          continue;
        }
        
        console.log(`Successfully connected to account ${account.phone_number}.`);
        console.log('Getting dialogs (can take some time)...');
        
        // Get all dialogs (chats, channels, users) for this account
        const dialogs = await client.getDialogs({
          limit: 100 // increase if needed
        });
        
        console.log(`Found ${dialogs.length} dialogs for account ${account.phone_number}.`);
        
        // Process each dialog
        for (const dialog of dialogs) {
          const entity = dialog.entity;
          if (!entity) continue;
          
          const id = entity.id.toString();
          const info = {
            name: entity.title || entity.username || entity.firstName || 'Unknown',
            username: entity.username || null,
            type: entity.className,
            identified_at: new Date().toISOString(),
            account: account.phone_number
          };
          
          // Add to the appropriate mapping category
          if (entity.className === 'Channel') {
            if (!mappings.channels[id]) {
              console.log(`Found channel: ${info.name} (${id})`);
              mappings.channels[id] = info;
              updated++;
            }
          } else if (entity.className === 'User') {
            if (!mappings.users[id]) {
              console.log(`Found user: ${info.name} (${id})`);
              mappings.users[id] = info;
              updated++;
            }
          } else if (entity.className === 'Chat' || entity.className === 'ChatForbidden') {
            if (!mappings.chats[id]) {
              console.log(`Found chat: ${info.name} (${id})`);
              mappings.chats[id] = info;
              updated++;
            }
          }
        }
        
        // Check for specific IDs provided by the user
        const customIds = process.argv.slice(2);
        if (customIds.length > 0) {
          console.log(`Looking up ${customIds.length} custom IDs...`);
          
          for (const customId of customIds) {
            try {
              // Skip if already known
              if (mappings.channels[customId] || mappings.users[customId] || mappings.chats[customId]) {
                console.log(`ID ${customId} is already mapped.`);
                continue;
              }
              
              if (mappings.ignored.includes(customId)) {
                console.log(`ID ${customId} is in the ignore list. Skipping.`);
                continue;
              }
              
              // Try to get the entity
              console.log(`Looking up entity for ID: ${customId}`);
              const entity = await client.getEntity(BigInt(customId));
              
              if (entity) {
                const info = {
                  name: entity.title || entity.username || entity.firstName || 'Unknown',
                  username: entity.username || null,
                  type: entity.className,
                  identified_at: new Date().toISOString(),
                  account: account.phone_number
                };
                
                // Add to the appropriate mapping category
                if (entity.className === 'Channel') {
                  mappings.channels[customId] = info;
                  console.log(`Identified channel: ${info.name} (${customId})`);
                } else if (entity.className === 'User') {
                  mappings.users[customId] = info;
                  console.log(`Identified user: ${info.name} (${customId})`);
                } else if (entity.className === 'Chat' || entity.className === 'ChatForbidden') {
                  mappings.chats[customId] = info;
                  console.log(`Identified chat: ${info.name} (${customId})`);
                }
                
                updated++;
                
                // Ask if user wants to monitor this channel
                if (entity.className === 'Channel') {
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
                    // Check if this channel already exists
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
                          numeric_id: customId,
                          name: info.name
                        }
                      );
                      console.log(`Updated existing channel ${existingChannel.channel_id} with numeric ID ${customId}`);
                    } else {
                      // Create new channel
                      const newChannel = await Channel.create({
                        channel_id: info.username || customId,
                        name: info.name,
                        username: info.username,
                        numeric_id: customId,
                        is_active: false
                      });
                      
                      console.log(`Created new channel entry: ${newChannel.channel_id} with numeric ID ${customId}`);
                    }
                  } else if (answer === 'i') {
                    // Add to ignore list
                    if (!mappings.ignored.includes(customId)) {
                      mappings.ignored.push(customId);
                      console.log(`Added ${customId} to ignore list`);
                    }
                  }
                }
              } else {
                console.log(`Could not identify entity ${customId}. Adding to ignore list.`);
                if (!mappings.ignored.includes(customId)) {
                  mappings.ignored.push(customId);
                }
              }
            } catch (error) {
              console.error(`Error identifying ID ${customId}: ${error.message}`);
              if (!mappings.ignored.includes(customId)) {
                mappings.ignored.push(customId);
                console.log(`Added ${customId} to ignore list due to error`);
              }
            }
          }
        }
        
        // Save mappings after each account
        if (updated > 0) {
          saveMappings(mappings);
        }
        
      } catch (error) {
        console.error(`Error mapping channels for account ${account.phone_number}: ${error.message}`);
      }
    }
    
    console.log(`Mapping completed. Updated ${updated} entities.`);
    return mappings;
    
  } catch (error) {
    console.error(`Error in mapActiveChannels: ${error.message}`);
    throw error;
  } finally {
    // Close database connection
    await mongoose.connection.close();
  }
}

// Run the script if called directly
if (require.main === module) {
  // Get custom IDs from command line arguments
  
  // Execute the function
  mapActiveChannels()
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
  module.exports = mapActiveChannels;
} 