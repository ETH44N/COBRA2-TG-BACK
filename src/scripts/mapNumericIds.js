require('dotenv').config();
const mongoose = require('mongoose');
const Channel = require('../models/Channel');
const logger = require('../utils/logger');

// Connect to database
const connectDB = require('../config/database');

/**
 * Map frequently seen numeric IDs to existing channels
 * Used to fix channel ID mapping issues
 */
const mapNumericIds = async (numericIds = []) => {
  try {
    await connectDB();
    
    if (!numericIds || numericIds.length === 0) {
      console.log('No numeric IDs provided. Please run this script with a list of numeric IDs to map.');
      console.log('Example: node src/scripts/mapNumericIds.js 1234567890 9876543210');
      return { mapped: 0 };
    }
    
    logger.info(`Attempting to map ${numericIds.length} numeric IDs to existing channels`, {
      source: 'map-numeric-ids'
    });
    
    // Get all channels
    const allChannels = await Channel.find({});
    
    // Track which numeric IDs we successfully mapped
    const mappedIds = [];
    
    // Process each numeric ID
    for (const numericId of numericIds) {
      try {
        // Check if any channel already has this numeric ID
        const existingWithNumericId = await Channel.findOne({ numeric_id: numericId.toString() });
        
        if (existingWithNumericId) {
          console.log(`Channel ${existingWithNumericId.channel_id} already has numeric ID ${numericId}`);
          mappedIds.push(numericId);
          continue;
        }
        
        // If we don't have a channel with this numeric ID, we need user input
        console.log(`\nNumeric ID: ${numericId}`);
        console.log('Available channels:');
        
        // Print channels without numeric IDs first
        const channelsWithoutNumericId = allChannels.filter(c => !c.numeric_id);
        const channelsWithNumericId = allChannels.filter(c => c.numeric_id);
        
        // Sort all channels by channel_id
        const sortedChannels = [...channelsWithoutNumericId, ...channelsWithNumericId].sort((a, b) => 
          a.channel_id.localeCompare(b.channel_id)
        );
        
        // Display channels 
        sortedChannels.forEach((channel, index) => {
          const numericIdInfo = channel.numeric_id ? `(has numeric_id: ${channel.numeric_id})` : '(no numeric_id)';
          console.log(`${index + 1}. ${channel.name} - ${channel.channel_id} ${numericIdInfo}`);
        });
        
        // Ask user to select a channel
        console.log('\nEnter channel number to assign this numeric ID to, or 0 to skip:');
        const answer = await new Promise(resolve => {
          process.stdin.once('data', data => {
            resolve(parseInt(data.toString().trim(), 10));
          });
        });
        
        if (answer === 0) {
          console.log(`Skipping numeric ID ${numericId}`);
          continue;
        }
        
        if (answer < 1 || answer > sortedChannels.length) {
          console.log(`Invalid selection. Skipping numeric ID ${numericId}`);
          continue;
        }
        
        const selectedChannel = sortedChannels[answer - 1];
        
        // Update the channel
        await Channel.updateOne(
          { _id: selectedChannel._id },
          { numeric_id: numericId.toString() }
        );
        
        console.log(`Assigned numeric ID ${numericId} to channel ${selectedChannel.channel_id}`);
        mappedIds.push(numericId);
        
      } catch (error) {
        console.error(`Error mapping numeric ID ${numericId}: ${error.message}`);
      }
    }
    
    console.log(`\nMapped ${mappedIds.length} numeric IDs successfully.`);
    return { mapped: mappedIds.length, mappedIds };
    
  } catch (error) {
    console.error(`Error mapping numeric IDs: ${error.message}`);
    throw error;
  } finally {
    // Close database connection
    await mongoose.connection.close();
  }
};

// Run the script if called directly
if (require.main === module) {
  // Get numeric IDs from command line arguments
  const numericIds = process.argv.slice(2);
  
  // Execute the function
  mapNumericIds(numericIds)
    .then(result => {
      console.log(`Mapped ${result.mapped} numeric IDs`);
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
} else {
  // Export for use as a module
  module.exports = mapNumericIds;
} 