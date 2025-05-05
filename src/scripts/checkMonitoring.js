require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const Channel = require('../models/Channel');
const AccountChannelAssignment = require('../models/AccountChannelAssignment');
const Account = require('../models/Account');
const Message = require('../models/Message');
const { getClient } = require('../services/telegram/client');
const { getMonitoringStatus, startListening } = require('../services/telegram/channelMonitor');

/**
 * Comprehensive check for monitoring issues
 * This script will:
 * 1. List all channels that should be active but don't have message activity
 * 2. Check for channels without active listeners
 * 3. Identify accounts with connection issues
 * 4. Attempt to fix issues when possible
 */
const runDiagnostics = async () => {
  try {
    // Connect to database
    await connectDB();
    console.log('Connected to database');
    
    // Get global monitoring status
    const status = await getMonitoringStatus();
    console.log('\n===== MONITORING OVERVIEW =====');
    console.log(`Total channels: ${status.total_channels}`);
    console.log(`Active channels: ${status.active_channels}`);
    console.log(`Channels with active listeners: ${status.monitored_channels}`);
    console.log(`Channels without listeners: ${status.channels_without_listeners.length}`);
    
    // Check channels without listeners
    if (status.channels_without_listeners.length > 0) {
      console.log('\n===== CHANNELS WITHOUT LISTENERS =====');
      for (const channel of status.channels_without_listeners) {
        console.log(`Channel: ${channel.channel_id} (${channel.name || 'No name'})`);
        
        // Get assignment
        const assignment = await AccountChannelAssignment.findOne({
          channel_id: channel.id
        }).populate('account_id');
        
        if (!assignment) {
          console.log(`  No account assignment found!`);
        } else {
          console.log(`  Assigned to account: ${assignment.account_id.phone_number} (${assignment.account_id.status})`);
          
          // Try to restart listener if account is active
          if (assignment.account_id.status === 'active') {
            try {
              console.log(`  Attempting to restart listener...`);
              const channelObj = await Channel.findById(channel.id);
              await startListening(channelObj, assignment.account_id);
              console.log(`  Successfully restarted listener`);
            } catch (error) {
              console.log(`  Failed to restart listener: ${error.message}`);
            }
          }
        }
      }
    }
    
    // Identify channels with no recent messages
    console.log('\n===== CHANNELS WITH NO RECENT MESSAGES =====');
    const activeChannels = await Channel.find({ is_active: true });
    
    for (const channel of activeChannels) {
      // Check latest message, if any
      const latestMessage = await Message.findOne({ channel_id: channel._id })
        .sort({ date: -1 })
        .lean();
      
      const messageCount = await Message.countDocuments({ channel_id: channel._id });
      
      if (messageCount === 0) {
        console.log(`Channel: ${channel.channel_id} (${channel.name || 'No name'}) - No messages recorded`);
        
        // Get assignment
        const assignment = await AccountChannelAssignment.findOne({
          channel_id: channel._id
        }).populate('account_id');
        
        if (assignment) {
          console.log(`  Assigned to account: ${assignment.account_id.phone_number} (${assignment.account_id.status})`);
          
          // Check listener status
          const activeListeners = require('../services/telegram/channelMonitor').activeListeners;
          const hasListener = activeListeners && activeListeners.has(channel._id.toString());
          console.log(`  Has active listener: ${hasListener ? 'Yes' : 'No'}`);
        } else {
          console.log(`  No account assignment found!`);
        }
      } else if (latestMessage) {
        const timeSinceLastMessage = Date.now() - new Date(latestMessage.date).getTime();
        const hoursSinceLastMessage = Math.floor(timeSinceLastMessage / (1000 * 60 * 60));
        
        // Flag channels with no messages in the last 24 hours (if they should be active)
        if (hoursSinceLastMessage > 24) {
          console.log(`Channel: ${channel.channel_id} (${channel.name || 'No name'}) - No messages in ${hoursSinceLastMessage} hours`);
          console.log(`  Total messages: ${messageCount}`);
          
          // Get assignment
          const assignment = await AccountChannelAssignment.findOne({
            channel_id: channel._id
          }).populate('account_id');
          
          if (assignment) {
            console.log(`  Assigned to account: ${assignment.account_id.phone_number} (${assignment.account_id.status})`);
            
            // Check listener status
            const activeListeners = require('../services/telegram/channelMonitor').activeListeners;
            const hasListener = activeListeners && activeListeners.has(channel._id.toString());
            console.log(`  Has active listener: ${hasListener ? 'Yes' : 'No'}`);
          } else {
            console.log(`  No account assignment found!`);
          }
        }
      }
    }
    
    // Check account connections
    console.log('\n===== ACCOUNT CONNECTION STATUS =====');
    const accounts = await Account.find({ status: 'active' });
    
    for (const account of accounts) {
      console.log(`Account: ${account.phone_number} (${account.current_channels_count} channels)`);
      
      try {
        // Try to get client
        const client = await getClient(account);
        console.log(`  Connection status: Connected`);
        
        // Check if actually connected
        const isConnected = !!client.connected;
        console.log(`  Is actually connected: ${isConnected ? 'Yes' : 'No'}`);
      } catch (error) {
        console.log(`  Connection status: Failed - ${error.message}`);
      }
    }
    
    console.log('\nDiagnostics completed.');
    
  } catch (error) {
    console.error('Error running diagnostics:', error);
  } finally {
    // Close connection when done
    await mongoose.connection.close();
    console.log('Database connection closed');
    process.exit(0);
  }
};

// Run the diagnostics
runDiagnostics(); 