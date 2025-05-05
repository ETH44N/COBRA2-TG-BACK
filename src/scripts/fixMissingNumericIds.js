require('dotenv').config();
const mongoose = require('mongoose');
const Channel = require('../models/Channel');
const Account = require('../models/Account');
const AccountChannelAssignment = require('../models/AccountChannelAssignment');
const { getClient } = require('../services/telegram/client');
const logger = require('../utils/logger');

// Connect to database
const connectDB = require('../config/database');

/**
 * Find channels with missing numeric ID and update them
 */
const fixMissingNumericIds = async () => {
  try {
    await connectDB();
    
    // Find all channels without a numeric_id
    const channelsWithoutNumericId = await Channel.find({ 
      numeric_id: { $exists: false },
      is_active: true
    });
    
    if (channelsWithoutNumericId.length === 0) {
      logger.info('No channels with missing numeric ID found', {
        source: 'fix-missing-numeric-ids'
      });
      return { fixed: 0 };
    }
    
    logger.info(`Found ${channelsWithoutNumericId.length} channels with missing numeric ID`, {
      source: 'fix-missing-numeric-ids'
    });
    
    let fixedCount = 0;
    const failed = [];
    
    // Process channels in batches to avoid rate limiting
    const batchSize = 10;
    const numBatches = Math.ceil(channelsWithoutNumericId.length / batchSize);
    
    for (let i = 0; i < numBatches; i++) {
      const batch = channelsWithoutNumericId.slice(i * batchSize, (i + 1) * batchSize);
      
      logger.info(`Processing batch ${i + 1}/${numBatches} (${batch.length} channels)`, {
        source: 'fix-missing-numeric-ids'
      });
      
      // Process each channel in the batch
      for (const channel of batch) {
        try {
          // Get the assignment for this channel
          const assignment = await AccountChannelAssignment.findOne({
            channel_id: channel._id
          }).populate('account_id');
          
          if (!assignment) {
            logger.warn(`Channel ${channel.channel_id} has no account assignment`, {
              source: 'fix-missing-numeric-ids'
            });
            failed.push({
              channel_id: channel.channel_id,
              reason: 'No account assignment'
            });
            continue;
          }
          
          if (assignment.account_id.status !== 'active') {
            logger.warn(`Channel ${channel.channel_id} is assigned to inactive account ${assignment.account_id.phone_number}`, {
              source: 'fix-missing-numeric-ids'
            });
            failed.push({
              channel_id: channel.channel_id,
              reason: 'Inactive account'
            });
            continue;
          }
          
          // Get client for account
          const client = await getClient(assignment.account_id);
          
          // Get entity for channel
          const entity = await client.getEntity(channel.channel_id);
          
          // Extract numeric ID
          const numericId = entity.id?.toString();
          
          if (!numericId) {
            logger.warn(`Could not get numeric ID for channel ${channel.channel_id}`, {
              source: 'fix-missing-numeric-ids'
            });
            failed.push({
              channel_id: channel.channel_id,
              reason: 'Could not get numeric ID'
            });
            continue;
          }
          
          // Update channel
          await Channel.updateOne(
            { _id: channel._id },
            { 
              numeric_id: numericId,
              name: entity.title || channel.name,
              username: entity.username || null
            }
          );
          
          logger.info(`Updated numeric ID for channel ${channel.channel_id} to ${numericId}`, {
            source: 'fix-missing-numeric-ids'
          });
          fixedCount++;
          
          // Wait to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error(`Error updating numeric ID for channel ${channel.channel_id}: ${error.message}`, {
            source: 'fix-missing-numeric-ids',
            context: { error: error.stack }
          });
          
          failed.push({
            channel_id: channel.channel_id,
            reason: error.message
          });
        }
      }
      
      // Wait between batches to avoid rate limiting
      if (i < numBatches - 1) {
        logger.info(`Waiting 5 seconds before next batch...`, {
          source: 'fix-missing-numeric-ids'
        });
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    logger.info(`Fixed ${fixedCount} channels with missing numeric ID`, {
      source: 'fix-missing-numeric-ids'
    });
    
    if (failed.length > 0) {
      logger.warn(`Failed to fix ${failed.length} channels`, {
        source: 'fix-missing-numeric-ids',
        context: { failed }
      });
    }
    
    return {
      fixed: fixedCount,
      failed
    };
  } catch (error) {
    logger.error(`Error fixing missing numeric IDs: ${error.message}`, {
      source: 'fix-missing-numeric-ids',
      context: { error: error.stack }
    });
    throw error;
  } finally {
    // Close database connection
    await mongoose.connection.close();
  }
};

// Run the script if called directly
if (require.main === module) {
  // Execute the function
  fixMissingNumericIds()
    .then(result => {
      console.log(`Fixed ${result.fixed} channels with missing numeric ID`);
      console.log(`Failed: ${result.failed?.length || 0}`);
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
} else {
  // Export for use as a module
  module.exports = fixMissingNumericIds;
} 