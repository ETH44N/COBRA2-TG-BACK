// test-proxy.js
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// Load environment variables
require('dotenv').config();

async function testProxy() {
  // Check if API credentials are available
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  
  if (!apiId || !apiHash) {
    console.error("ERROR: Telegram API ID or Hash not found in environment variables.");
    console.error("Make sure your .env file contains:");
    console.error("TELEGRAM_API_ID=your_api_id");
    console.error("TELEGRAM_API_HASH=your_api_hash");
    return;
  }
  
  console.log("Creating Telegram client with proxy...");
  
  const client = new TelegramClient(
    new StringSession(""),  // Empty session for testing
    parseInt(apiId),
    apiHash,
    {
      connectionRetries: 3,
      proxy: {
        ip: 'rp.scrapegw.com',
        port: 6060,
        username: 's702ecpqsnoiptz',
        password: 'aqxr4fr1x8y3tb4',
        socksType: 5
      }
    }
  );

  try {
    console.log("Connecting to Telegram...");
    await client.connect();
    console.log("Successfully connected with proxy!");
    
    // Try to resolve a simple, well-known channel as a test
    console.log("Attempting to resolve @telegram...");
    const entity = await client.getEntity("telegram");
    console.log("Successfully resolved entity:", entity.id);

    await client.disconnect();
    console.log("Test completed successfully!");
  } catch (error) {
    console.error("Error during proxy test:", error.message);
  }
}

// Print environment variables for debugging (masking sensitive data)
console.log("Environment variables check:");
console.log(`TELEGRAM_API_ID exists: ${process.env.TELEGRAM_API_ID ? 'Yes' : 'No'}`);
console.log(`TELEGRAM_API_HASH exists: ${process.env.TELEGRAM_API_HASH ? 'Yes' : 'No'}`);

testProxy();