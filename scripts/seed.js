require('dotenv').config();
const mongoose = require('mongoose');
const Account = require('../src/models/Account');
const Webhook = require('../src/models/Webhook');
const logger = require('../src/utils/logger');
const appConfig = require('../src/config/app');

// Connect to database
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info('Connected to MongoDB for seeding');
  
  try {
    // Check if default webhook exists
    const webhookCount = await Webhook.countDocuments();
    
    if (webhookCount === 0 && appConfig.defaultWebhookUrl) {
      // Create default webhook
      await Webhook.create({
        url: appConfig.defaultWebhookUrl,
        event_type: 'all',
        secret_key: appConfig.webhookSecret,
        status: 'active'
      });
      
      logger.info(`Created default webhook: ${appConfig.defaultWebhookUrl}`);
    }
    
    // Add sample accounts if needed
    const accountCount = await Account.countDocuments();
    
    if (accountCount === 0 && process.env.SEED_ACCOUNTS === 'true') {
      // This is just a placeholder - in a real app, you'd need to provide actual session strings
      logger.info('No accounts found. To add accounts, use the API or set up manually.');
    }
    
    logger.info('Database seeding completed');
    process.exit(0);
  } catch (error) {
    logger.error(`Error seeding database: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 