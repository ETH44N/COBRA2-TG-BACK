const createClient = async (session, apiId, apiHash) => {
    try {
        // Create client
        const client = new TelegramClient(
            new StringSession(session),
            parseInt(apiId), 
            apiHash,
            {
                connectionRetries: 5,
                useWSS: false,
                baseLogger: new Logger(LogLevel.DEBUG)
            }
        );

        // Connect
        logger.info('Connecting to Telegram...');
        await client.connect();
        
        // Log connection state
        const isConnected = await client.connected;
        logger.info(`Telegram client connection state: ${isConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
        
        // Check if user is authorized
        if (!(await client.isUserAuthorized())) {
            logger.error('User is not authorized');
            throw new Error('User is not authorized');
        }
        
        // Add event handler for connection status changes
        client.addEventHandler((update) => {
            if (update.className === 'UpdateConnectionState') {
                logger.info(`Connection state changed: ${update.state}`, {
                    source: 'telegram-client'
                });
            }
        });

        logger.info('Client connected and authorized successfully');
        return client;
    } catch (error) {
        logger.error(`Failed to create Telegram client: ${error.message}`, {
            source: 'telegram-client',
            context: { error: error.stack }
        });
        throw error;
    }
}; 