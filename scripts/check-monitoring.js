require('dotenv').config();
const mongoose = require('mongoose');
const Channel = require('../src/models/Channel');
const Account = require('../src/models/Account');
const AccountChannelAssignment = require('../src/models/AccountChannelAssignment');
const { getActiveClientCount } = require('../src/services/telegram/client');
const logger = require('../src/utils/logger');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info('Connected to MongoDB for monitoring check');
  
  try {
    // Get counts
    const channelCount = await Channel.countDocuments();
    const accountCount = await Account.countDocuments();
    const activeAccountCount = await Account.countDocuments({ status: 'active' });
    const assignmentCount = await AccountChannelAssignment.countDocuments();
    const activeClientCount = getActiveClientCount();
    
    // Get channels per account
    const accountsWithChannels = await Account.aggregate([
      {
        $lookup: {
          from: 'accountchannelassignments',
          localField: '_id',
          foreignField: 'account_id',
          as: 'assignments'
        }
      },
      {
        $project: {
          phone_number: 1,
          username: 1,
          status: 1,
          channel_count: { $size: '$assignments' }
        }
      },
      { $sort: { channel_count: -1 } }
    ]);
    
    // Print report
    console.log('\n=== MONITORING STATUS REPORT ===');
    console.log(`Total Channels: ${channelCount}`);
    console.log(`Total Accounts: ${accountCount}`);
    console.log(`Active Accounts: ${activeAccountCount}`);
    console.log(`Channel Assignments: ${assignmentCount}`);
    console.log(`Active Telegram Clients: ${activeClientCount}`);
    console.log('\nAccounts with Channels:');
    
    accountsWithChannels.forEach(acc => {
      if (acc.channel_count > 0) {
        console.log(`- ${acc.phone_number} (${acc.username}): ${acc.channel_count} channels (${acc.status})`);
      }
    });
    
    console.log('\nAccounts without Channels:');
    const accountsWithoutChannels = accountsWithChannels.filter(acc => acc.channel_count === 0);
    console.log(`Total: ${accountsWithoutChannels.length}`);
    
    console.log('\n===============================');
    
    process.exit(0);
  } catch (error) {
    logger.error(`Error checking monitoring status: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 