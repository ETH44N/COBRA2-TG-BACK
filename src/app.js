require('dotenv').config();
const express = require('express');
const connectDB = require('./config/database');
const logger = require('./utils/logger');
const cron = require('node-cron');
const { initializeAccounts } = require('./services/telegram/accountManager');
const { initializeChannelMonitoring } = require('./services/telegram/channelMonitor');
const { retryFailedWebhooks } = require('./services/webhook/dispatcher');
const { checkAccountsHealth, restartFailedListeners } = require('./services/telegram/accountManager');
const appConfig = require('./config/app');
const applySecurityMiddleware = require('./middleware/security');
const globalErrorHandler = require('./utils/errorHandler');
const mongoose = require('mongoose');
const Account = require('./models/Account');
const Channel = require('./models/Channel');
const Message = require('./models/Message');

// Import routes
const accountRoutes = require('./routes/accountRoutes');
const channelRoutes = require('./routes/channelRoutes');
const messageRoutes = require('./routes/messageRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

// Initialize Express app
const app = express();

// Apply security middleware
applySecurityMiddleware(app);

// Middleware
app.use(express.json());

// Routes
app.use('/api/accounts', accountRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/webhooks', webhookRoutes);

// Debug endpoint to check app status
app.get('/debug', (req, res) => {
  logger.info('Debug endpoint accessed', { source: 'app' });
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    routes: {
      messageRoutes: !!messageRoutes,
      accountRoutes: !!accountRoutes,
      channelRoutes: !!channelRoutes,
      webhookRoutes: !!webhookRoutes
    }
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check database connection
    const dbConnected = mongoose.connection.readyState === 1;
    
    // Check active accounts
    const activeAccounts = await Account.countDocuments({ status: 'active', isBanned: { $ne: true } });
    
    // Check active channels
    const activeChannels = await Channel.countDocuments({ is_active: true });
    
    // Check for messages in the last hour
    const recentMessages = await Message.countDocuments({
      created_at: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
    });
    
    // Check active listeners
    let activeListeners = 0;
    try {
      const channelMonitor = require('./services/telegram/channelMonitor');
      if (channelMonitor.activeAccountListeners) {
        activeListeners = channelMonitor.activeAccountListeners.size;
      }
    } catch (error) {
      logger.error(`Error checking active listeners: ${error.message}`, {
        source: 'health-check',
        context: { error: error.stack }
      });
    }
    
    // Check message queue
    let queueLength = 0;
    try {
      const messageListener = require('./services/telegram/messageListener');
      if (messageListener.messageQueue) {
        queueLength = messageListener.messageQueue.queue.length;
      }
    } catch (error) {
      logger.error(`Error checking message queue: ${error.message}`, {
        source: 'health-check',
        context: { error: error.stack }
      });
    }
    
    const status = dbConnected && activeAccounts > 0 && activeListeners > 0 ? 'ok' : 'degraded';
    
    res.status(200).json({
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        connected: dbConnected
      },
      accounts: {
        active: activeAccounts
      },
      channels: {
        active: activeChannels
      },
      messages: {
        recentHour: recentMessages
      },
      listeners: {
        active: activeListeners
      },
      queue: {
        length: queueLength
      }
    });
  } catch (error) {
    logger.error(`Health check failed: ${error.message}`, {
      source: 'health-check',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Error handling middleware
app.use(globalErrorHandler);

// Initialize application
const initializeApp = async () => {
  try {
    // Connect to database
    await connectDB();
    
    // Initialize Telegram accounts
    await initializeAccounts();
    
    // Initialize channel monitoring
    await initializeChannelMonitoring();
    
    // Schedule jobs
    
    // Retry failed webhooks every hour
    cron.schedule('0 * * * *', async () => {
      logger.info('Running scheduled job: Retry failed webhooks', {
        source: 'scheduler'
      });
      await retryFailedWebhooks();
    });
    
    // Check account health every 6 hours
    cron.schedule('0 */6 * * *', async () => {
      logger.info('Running scheduled job: Check accounts health', {
        source: 'scheduler'
      });
      await checkAccountsHealth();
    });
    
    // Check for failed listeners every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
      logger.info('Running scheduled job: Check for failed listeners', {
        source: 'scheduler'
      });
      await restartFailedListeners();
    });
    
    // Start server
    const PORT = appConfig.port;
    app.listen(PORT, () => {
      logger.info(`Server running in ${appConfig.environment} mode on port ${PORT}`, {
        source: 'app'
      });
    });
  } catch (error) {
    logger.error(`Failed to initialize application: ${error.message}`, {
      source: 'app',
      context: { error: error.stack }
    });
    process.exit(1);
  }
};

// Start the application
initializeApp();

module.exports = app; 