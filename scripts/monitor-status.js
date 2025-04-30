require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');
const Account = require('../src/models/Account');
const Channel = require('../src/models/Channel');
const AccountChannelAssignment = require('../src/models/AccountChannelAssignment');
const Message = require('../src/models/Message');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('Connected to MongoDB for monitoring');
  monitorStatus();
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

async function monitorStatus() {
  try {
    console.log('\n========== MONITORING STATUS ==========\n');
    
    // Account statistics
    const accounts = await Account.find({});
    const activeAccounts = accounts.filter(a => a.status === 'active' && !a.isBanned);
    const bannedAccounts = accounts.filter(a => a.isBanned);
    const inactiveAccounts = accounts.filter(a => a.status !== 'active' && !a.isBanned);
    
    console.log('ACCOUNT STATISTICS:');
    console.log(`Total accounts: ${accounts.length}`);
    console.log(`Active accounts: ${activeAccounts.length}`);
    console.log(`Banned accounts: ${bannedAccounts.length}`);
    console.log(`Inactive accounts: ${inactiveAccounts.length}`);
    
    // Channel statistics
    const channels = await Channel.find({});
    const activeChannels = channels.filter(c => c.is_active);
    const inactiveChannels = channels.filter(c => !c.is_active);
    
    console.log('\nCHANNEL STATISTICS:');
    console.log(`Total channels: ${channels.length}`);
    console.log(`Active channels: ${activeChannels.length}`);
    console.log(`Inactive channels: ${inactiveChannels.length}`);
    
    // Channel assignments
    const assignments = await AccountChannelAssignment.find({})
      .populate('account_id')
      .populate('channel_id');
    
    const activeAssignments = assignments.filter(a => 
      a.status === 'active' && 
      a.account_id && 
      a.account_id.status === 'active' && 
      !a.account_id.isBanned &&
      a.channel_id && 
      a.channel_id.is_active
    );
    
    const failedAssignments = assignments.filter(a => 
      a.status === 'failed' || 
      !a.account_id || 
      a.account_id.status !== 'active' || 
      a.account_id.isBanned ||
      !a.channel_id || 
      !a.channel_id.is_active
    );
    
    console.log('\nASSIGNMENT STATISTICS:');
    console.log(`Total assignments: ${assignments.length}`);
    console.log(`Active assignments: ${activeAssignments.length}`);
    console.log(`Failed/invalid assignments: ${failedAssignments.length}`);
    
    // Message statistics
    const totalMessages = await Message.countDocuments({});
    const deletedMessages = await Message.countDocuments({ is_deleted: true });
    const lastMessage = await Message.findOne({}).sort({ created_at: -1 });
    
    console.log('\nMESSAGE STATISTICS:');
    console.log(`Total messages saved: ${totalMessages}`);
    console.log(`Deleted messages tracked: ${deletedMessages}`);
    
    if (lastMessage) {
      console.log(`Last message received: ${new Date(lastMessage.created_at).toLocaleString()}`);
    } else {
      console.log('No messages received yet');
    }
    
    // Account distribution
    console.log('\nACCOUNT CHANNEL DISTRIBUTION:');
    let accountsWithChannelCount = [];
    
    for (const account of activeAccounts) {
      const channelCount = await AccountChannelAssignment.countDocuments({
        account_id: account._id,
        status: 'active'
      });
      
      accountsWithChannelCount.push({
        phone_number: account.phone_number,
        username: account.username,
        channels: channelCount
      });
    }
    
    // Sort by channel count descending
    accountsWithChannelCount.sort((a, b) => b.channels - a.channels);
    
    // Print the top 10 accounts by channel count
    console.log('Top 10 accounts by channel count:');
    accountsWithChannelCount.slice(0, 10).forEach((acc, index) => {
      console.log(`  ${index + 1}. ${acc.phone_number} (${acc.username}): ${acc.channels} channels`);
    });
    
    // Print accounts with no channels
    const accountsWithNoChannels = accountsWithChannelCount.filter(a => a.channels === 0);
    console.log(`\nAccounts with no channels: ${accountsWithNoChannels.length}`);
    
    if (accountsWithNoChannels.length > 0) {
      console.log('First 5 accounts with no channels:');
      accountsWithNoChannels.slice(0, 5).forEach((acc, index) => {
        console.log(`  ${index + 1}. ${acc.phone_number} (${acc.username})`);
      });
    }
    
    // Channels without messages
    const channelsWithoutMessages = [];
    
    for (const channel of activeChannels) {
      const messageCount = await Message.countDocuments({
        channel_id: channel._id
      });
      
      if (messageCount === 0) {
        channelsWithoutMessages.push(channel);
      }
    }
    
    console.log(`\nActive channels without messages: ${channelsWithoutMessages.length}`);
    
    if (channelsWithoutMessages.length > 0) {
      console.log('First 5 channels without messages:');
      channelsWithoutMessages.slice(0, 5).forEach((channel, index) => {
        console.log(`  ${index + 1}. ${channel.name} (${channel.channel_id})`);
      });
    }
    
    console.log('\n========== END OF STATUS REPORT ==========\n');
    
    // Close the MongoDB connection and exit
    mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Error in monitoring status:', error);
    mongoose.connection.close();
    process.exit(1);
  }
} 