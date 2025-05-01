require('dotenv').config();
const express = require('express');
const connectDB = require('./config/database');
const logger = require('./utils/logger');
const cron = require('node-cron');
const { initializeAccounts } = require('./services/telegram/accountManager');
const { initializeChannelMonitoring } = require('./services/telegram/channelMonitor');
const { retryFailedWebhooks } = require('./services/webhook/dispatcher');
const { checkAccountsHealth } = require('./services/telegram/accountManager');
const appConfig = require('./config/app');
const applySecurityMiddleware = require('./middleware/security');
const globalErrorHandler = require('./utils/errorHandler');

// Import routes
const channelRoutes = require('./routes/channelRoutes');
const accountRoutes = require('./routes/accountRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const messageRoutes = require('./routes/messageRoutes');

// Initialize Express app
const app = express();

// Apply security middleware
applySecurityMiddleware(app);

// Middleware
app.use(express.json());

// Routes
app.use('/api/channels', channelRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/messages', messageRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
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