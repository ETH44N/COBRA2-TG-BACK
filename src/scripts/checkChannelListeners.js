require('dotenv').config();
const mongoose = require('mongoose');
const Channel = require('../models/Channel');
const Account = require('../models/Account');
const AccountChannelAssignment = require('../models/AccountChannelAssignment');
const { getClient } = require('../services/telegram/client');
const { getMonitoringStatus, fixChannelMonitoring } = require('../services/telegram/channelMonitor');
const logger = require('../utils/logger');

// Connect to database
const connectDB = require('../config/database');

/**
 * Check the status of all channel listeners
 */
const checkChannelListeners = async () => {
  try {
    await connectDB();
    
    // Get monitoring status
    const status = await getMonitoringStatus();
    
    console.log('=== Channel Monitoring Status ===');
    console.log(`Total channels: ${status.total_channels}`);
    console.log(`Active channels: ${status.active_channels}`);
    console.log(`Monitored channels: ${status.monitored_channels}`);
    console.log(`Channels without listeners: ${status.channels_without_listeners.length}`);
    console.log(`Channels missing numeric ID: ${status.channels_missing_numeric_id.length}`);
    
    // Show account stats
    console.log('\n=== Account Stats ===');
    for (const account of status.account_stats) {
      console.log(`${account.phone_number}: ${account.active_listener_count}/${account.assigned_channel_count} active listeners`);
    }
    
    // Show channels without listeners
    if (status.channels_without_listeners.length > 0) {
      console.log('\n=== Channels Without Listeners ===');
      for (const channel of status.channels_without_listeners) {
        console.log(`${channel.name} (${channel.channel_id})`);
      }
    }
    
    // Show channels missing numeric ID
    if (status.channels_missing_numeric_id.length > 0) {
      console.log('\n=== Channels Missing Numeric ID ===');
      for (const channel of status.channels_missing_numeric_id) {
        console.log(`${channel.name} (${channel.channel_id})`);
      }
    }
    
    // Ask to fix issues
    if (status.channels_without_listeners.length > 0) {
      console.log('\nWould you like to fix channels without listeners? (y/n)');
      
      // Note: In a real implementation, you'd use readline or similar to get input
      // This is just a placeholder
      const answer = await new Promise(resolve => {
        process.stdin.once('data', data => {
          resolve(data.toString().trim().toLowerCase());
        });
      });
      
      if (answer === 'y') {
        console.log('Fixing channel monitoring issues...');
        const result = await fixChannelMonitoring();
        console.log(`Fixed ${result.fixed_count} channels`);
      }
    }
    
    return status;
  } catch (error) {
    console.error(`Error checking channel listeners: ${error.message}`);
    throw error;
  } finally {
    // Close database connection
    await mongoose.connection.close();
  }
};

// Run the script if called directly
if (require.main === module) {
  // Execute the function
  checkChannelListeners()
    .then(() => {
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
} else {
  // Export for use as a module
  module.exports = checkChannelListeners;
} 