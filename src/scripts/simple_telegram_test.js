/**
 * Simple Telegram Connection Test
 * 
 * This script tests the basic Telegram connection using the first account in the database.
 * It's designed to be minimal to help diagnose connection issues.
 */

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mongoose = require('mongoose');

// Get API credentials from environment
const API_ID = process.env.TELEGRAM_API_ID;
const API_HASH = process.env.TELEGRAM_API_HASH;

// Check if credentials are available
if (!API_ID || !API_HASH) {
  console.error("ERROR: Telegram API credentials not found!");
  console.error("Please set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env file");
  process.exit(1);
}

console.log(`API_ID: ${API_ID}`);
console.log(`API_HASH: ${API_HASH.substring(0, 4)}...${API_HASH.substring(API_HASH.length - 4)}`);

// Schema for account (simplified for this test)
const accountSchema = new mongoose.Schema({
  _id: {
    type: String
  },
  phone_number: String,
  session_string: String,
  status: String
});

// Connect to MongoDB and test Telegram connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log("Connected to MongoDB");
  
  try {
    // Get first active account
    const Account = mongoose.model('Account', accountSchema);
    const account = await Account.findOne({ status: 'active' });
    
    if (!account) {
      console.error("No active accounts found in database");
      await mongoose.connection.close();
      process.exit(1);
    }
    
    console.log(`Using account: ${account.phone_number || account._id}`);
    
    // Create Telegram client
    const session = new StringSession(account.session_string);
    const client = new TelegramClient(
      session,
      parseInt(API_ID, 10),
      API_HASH,
      {
        connectionRetries: 3,
        retryDelay: 1000
      }
    );
    
    console.log("Connecting to Telegram...");
    await client.connect();
    
    console.log("Getting self information...");
    const me = await client.getMe();
    
    console.log(`Successfully connected to Telegram as: ${me.username || me.firstName || me.phone}`);
    console.log(`User ID: ${me.id}`);
    console.log(`First Name: ${me.firstName}`);
    console.log(`Last Name: ${me.lastName || 'N/A'}`);
    console.log(`Username: ${me.username || 'N/A'}`);
    console.log(`Premium: ${me.premium ? 'Yes' : 'No'}`);
    
    // Disconnect
    await client.disconnect();
    console.log("Disconnected from Telegram");
    
    await mongoose.connection.close();
    console.log("Disconnected from MongoDB");
    
    console.log("Test PASSED ✅");
  } catch (error) {
    console.error("Error testing Telegram connection:", error);
    await mongoose.connection.close();
    console.log("Test FAILED ❌");
    process.exit(1);
  }
})
.catch(err => {
  console.error("MongoDB connection error:", err);
  process.exit(1);
}); 