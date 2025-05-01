#!/usr/bin/env node

/**
 * Configuration Verification Script
 * 
 * This script verifies that the application's configuration is correct.
 * Run this before starting the application to ensure everything is set up correctly.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('\n======= CONFIGURATION VERIFICATION =======\n');

let isError = false;

// Check for .env file
const rootDir = path.resolve(__dirname, '../../');
const envPath = path.join(rootDir, '.env');

if (!fs.existsSync(envPath)) {
  console.error('❌ ERROR: .env file not found!');
  console.error('   Create a .env file in the project root directory.');
  isError = true;
} else {
  console.log('✅ .env file exists');
  
  // Check essential environment variables
  const essentialVars = [
    { name: 'MONGODB_URI', description: 'MongoDB connection string' },
    { name: 'TELEGRAM_API_ID', description: 'Telegram API ID' },
    { name: 'TELEGRAM_API_HASH', description: 'Telegram API Hash' }
  ];
  
  console.log('\nChecking essential environment variables:');
  for (const v of essentialVars) {
    const value = process.env[v.name];
    if (!value) {
      console.error(`❌ ${v.name} is missing!`);
      isError = true;
    } else {
      if (v.name === 'TELEGRAM_API_ID') {
        // Check if it's a valid number
        const parsed = parseInt(value, 10);
        if (isNaN(parsed)) {
          console.error(`❌ ${v.name} is not a valid number! Value: ${value}`);
          isError = true;
        } else {
          console.log(`✅ ${v.name} is set: ${parsed}`);
        }
      } else if (v.name === 'TELEGRAM_API_HASH') {
        console.log(`✅ ${v.name} is set: ${value.substring(0, 4)}...${value.substring(value.length - 4)}`);
      } else if (v.name === 'MONGODB_URI') {
        // Mask the connection string for security
        const maskedUri = value.replace(/(mongodb(\+srv)?:\/\/)([^:]+):([^@]+)@/, '$1****:****@');
        console.log(`✅ ${v.name} is set: ${maskedUri}`);
      } else {
        console.log(`✅ ${v.name} is set`);
      }
    }
  }
}

// Verify MongoDB connection
console.log('\nChecking MongoDB connection:');
try {
  const mongo = require('mongodb');
  const mongoose = require('mongoose');
  
  // Try to parse the MongoDB URI
  if (process.env.MONGODB_URI) {
    try {
      const parsedUrl = new URL(process.env.MONGODB_URI);
      console.log(`✅ MongoDB URI format is valid`);
    } catch (e) {
      console.error(`❌ MongoDB URI format is invalid: ${e.message}`);
      isError = true;
    }
  }
  
  console.log('✅ MongoDB modules are installed');
} catch (e) {
  console.error(`❌ MongoDB modules are not installed: ${e.message}`);
  isError = true;
}

// Verify Telegram modules
console.log('\nChecking Telegram modules:');
try {
  const telegram = require('telegram');
  const { StringSession } = require('telegram/sessions');
  
  console.log(`✅ Telegram modules are installed (version: ${telegram.version || 'unknown'})`);
  console.log(`   Hint: If you're having issues, try upgrading telegram with:`);
  console.log(`   npm install telegram@latest`);
} catch (e) {
  console.error(`❌ Telegram modules are not installed: ${e.message}`);
  isError = true;
}

// Check if we have accounts in the database (if MongoDB is available)
if (process.env.MONGODB_URI) {
  console.log('\nChecking Telegram accounts:');
  try {
    // This is a bit hacky but works for a simple check
    const accountCheck = `
      const mongoose = require('mongoose');
      mongoose.connect('${process.env.MONGODB_URI}', { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
        const Account = mongoose.model('Account', new mongoose.Schema({ status: String, session_string: String }));
        const accounts = await Account.find({ status: 'active' });
        console.log(JSON.stringify({ count: accounts.length, active: accounts.filter(a => a.status === 'active').length }));
        await mongoose.connection.close();
        process.exit(0);
      }).catch(err => {
        console.error(err.message);
        process.exit(1);
      });
    `;
    
    try {
      const result = execSync(`node -e "${accountCheck.replace(/"/g, '\\"')}"`, { timeout: 5000 }).toString().trim();
      const { count, active } = JSON.parse(result);
      
      if (count === 0) {
        console.warn(`⚠️ No Telegram accounts found in the database!`);
        console.warn(`   You need to add at least one account to monitor channels.`);
      } else {
        console.log(`✅ Found ${count} Telegram accounts (${active} active)`);
      }
    } catch (e) {
      console.error(`❌ Failed to check Telegram accounts: ${e.message}`);
    }
  } catch (e) {
    console.error(`❌ Error checking accounts: ${e.message}`);
  }
}

// Final result
console.log('\n======= VERIFICATION SUMMARY =======');
if (isError) {
  console.error('❌ There are configuration issues that need to be fixed!');
  console.error('   Please fix the issues marked with ❌ above.');
  console.error('\nNeed help? Run: node src/scripts/check_env.js for more detailed diagnostics.');
} else {
  console.log('✅ All basic configuration checks passed!');
  console.log('\nNext steps:');
  console.log('1. For detailed diagnostics: node src/scripts/diagnose_telegram.js');
  console.log('2. For basic functionality test: node src/scripts/simple_telegram_test.js');
  console.log('3. Start the application: npm start');
}

console.log('\n=======================================\n');

if (isError) {
  process.exit(1);
} 