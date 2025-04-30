const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const logger = require('../../utils/logger');

// Telegram API credentials - using the ones that work
const API_ID = 16505588;
const API_HASH = "8627549376532003f12e386841814511";

// Store active clients
const activeClients = new Map();

/**
 * Get or create a Telegram client for an account
 * @param {Object} account - Account document from database
 * @returns {Promise<TelegramClient>} - Connected Telegram client
 */
const getClient = async (account) => {
  try {
    // Check if client already exists and is connected
    if (activeClients.has(account._id.toString())) {
      const existingClient = activeClients.get(account._id.toString());
      
      // Check if client is connected
      if (existingClient.connected) {
        logger.debug(`Using existing client for account ${account.phone_number}`, {
          source: 'telegram-client'
        });
        return existingClient;
      }
      
      // If client exists but is disconnected, try to reconnect
      try {
        await existingClient.connect();
        return existingClient;
      } catch (error) {
        logger.error(`Failed to reconnect client for account ${account.phone_number}: ${error.message}`, {
          source: 'telegram-client',
          context: { error: error.stack }
        });
        // Continue to create a new client
      }
    }
    
    // Create a new client
    logger.info(`Creating new Telegram client for account ${account.phone_number}`, {
      source: 'telegram-client'
    });
    
    const session = new StringSession(account.session_string);
    
    const client = new TelegramClient(
      session,
      API_ID,
      API_HASH,
      {
        connectionRetries: 3,
        useWSS: true,
        timeout: 30000,
      }
    );
    
    // Connect to Telegram
    await client.connect();
    
    // Check if authorized
    const isAuthorized = await client.isUserAuthorized();
    if (!isAuthorized) {
      throw new Error(`Account ${account.phone_number} is not authorized`);
    }
    
    // Store client in active clients map
    activeClients.set(account._id.toString(), client);
    
    return client;
  } catch (error) {
    logger.error(`Failed to create Telegram client for account ${account.phone_number}: ${error.message}`, {
      source: 'telegram-client',
      context: { error: error.stack }
    });
    throw error;
  }
};

/**
 * Disconnect a client for an account
 * @param {string} accountId - Account ID
 * @returns {Promise<boolean>} - Success status
 */
const disconnectClient = async (accountId) => {
  try {
    if (activeClients.has(accountId)) {
      const client = activeClients.get(accountId);
      await client.disconnect();
      activeClients.delete(accountId);
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`Error disconnecting client: ${error.message}`, {
      source: 'telegram-client',
      context: { error: error.stack }
    });
    return false;
  }
};

/**
 * Disconnect all active clients
 * @returns {Promise<void>}
 */
const disconnectAllClients = async () => {
  try {
    const disconnectPromises = [];
    
    for (const [accountId, client] of activeClients.entries()) {
      disconnectPromises.push(
        client.disconnect()
          .then(() => {
            logger.info(`Disconnected client for account ${accountId}`, {
              source: 'telegram-client'
            });
          })
          .catch(error => {
            logger.error(`Error disconnecting client for account ${accountId}: ${error.message}`, {
              source: 'telegram-client',
              context: { error: error.stack }
            });
          })
      );
    }
    
    await Promise.all(disconnectPromises);
    activeClients.clear();
    
    logger.info('All Telegram clients disconnected', {
      source: 'telegram-client'
    });
  } catch (error) {
    logger.error(`Error disconnecting all clients: ${error.message}`, {
      source: 'telegram-client',
      context: { error: error.stack }
    });
  }
};

/**
 * Get the count of active clients
 * @returns {number} - Number of active clients
 */
const getActiveClientCount = () => {
  return activeClients.size;
};

module.exports = {
  getClient,
  disconnectClient,
  disconnectAllClients,
  getActiveClientCount
}; 