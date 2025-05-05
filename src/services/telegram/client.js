const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const logger = require('../../utils/logger');

// Telegram API credentials - using the ones that work
const API_ID = 16505588;
const API_HASH = "8627549376532003f12e386841814511";

// Store active clients
const activeClients = new Map();

// Connection attempt tracking to avoid excessive reconnection attempts
const connectionAttempts = new Map();
const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_ATTEMPT_RESET_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Verify a client is actually connected by sending a ping
 * @param {TelegramClient} client - Telegram client to check
 * @returns {Promise<boolean>} - Whether client is connected
 */
const verifyClientConnection = async (client) => {
  try {
    if (!client.connected) {
      return false;
    }
    
    // Try to ping the server
    await client.invoke({ className: 'Ping', pingId: BigInt(Math.floor(Math.random() * 1000000000)) });
    return true;
  } catch (error) {
    logger.warn(`Ping check failed: ${error.message}`, {
      source: 'telegram-client'
    });
    return false;
  }
};

/**
 * Get or create a Telegram client for an account
 * @param {Object} account - Account document from database
 * @returns {Promise<TelegramClient>} - Connected Telegram client
 */
const getClient = async (account) => {
  try {
    const accountId = account._id.toString();
    
    // Check if we've been trying to connect too many times
    if (connectionAttempts.has(accountId)) {
      const attempts = connectionAttempts.get(accountId);
      if (attempts.count >= MAX_CONNECTION_ATTEMPTS) {
        const timeSinceLastAttempt = Date.now() - attempts.lastAttempt;
        
        if (timeSinceLastAttempt < CONNECTION_ATTEMPT_RESET_MS) {
          throw new Error(`Too many connection attempts for account ${account.phone_number}, try again later`);
        } else {
          // Reset attempts after the cooldown period
          connectionAttempts.set(accountId, { count: 1, lastAttempt: Date.now() });
        }
      } else {
        // Increment attempt count
        connectionAttempts.set(accountId, { 
          count: attempts.count + 1, 
          lastAttempt: Date.now() 
        });
      }
    } else {
      // First attempt
      connectionAttempts.set(accountId, { count: 1, lastAttempt: Date.now() });
    }
    
    // Check if client already exists and is connected
    if (activeClients.has(accountId)) {
      const existingClient = activeClients.get(accountId);
      
      // Verify connection with ping
      const isConnected = await verifyClientConnection(existingClient);
      
      // Check if client is connected
      if (isConnected) {
        logger.debug(`Using existing client for account ${account.phone_number}`, {
          source: 'telegram-client'
        });
        return existingClient;
      }
      
      // If client exists but is disconnected, try to reconnect
      try {
        logger.info(`Reconnecting client for account ${account.phone_number}`, {
          source: 'telegram-client'
        });
        
        await existingClient.connect();
        
        // Verify connection after reconnect
        const reconnectSuccess = await verifyClientConnection(existingClient);
        
        if (reconnectSuccess) {
          logger.info(`Successfully reconnected client for account ${account.phone_number}`, {
            source: 'telegram-client'
          });
          return existingClient;
        } else {
          logger.warn(`Reconnection failed for account ${account.phone_number}, creating new client`, {
            source: 'telegram-client'
          });
          // Continue to create a new client
        }
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
    activeClients.set(accountId, client);
    
    // Reset connection attempt counter on success
    connectionAttempts.set(accountId, { count: 0, lastAttempt: Date.now() });
    
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