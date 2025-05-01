/**
 * Environment Variables Check Script
 * 
 * This script checks if all necessary environment variables are properly set.
 * It's designed to help diagnose configuration issues.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

console.log("======= ENVIRONMENT VARIABLES CHECK =======");

// Essential variables for the application
const essentialVars = [
  { name: 'MONGODB_URI', description: 'MongoDB connection string' },
  { name: 'TELEGRAM_API_ID', description: 'Telegram API ID' },
  { name: 'TELEGRAM_API_HASH', description: 'Telegram API Hash' },
  { name: 'PORT', description: 'Port for the API server', default: '3000' }
];

// Additional variables that might be useful
const additionalVars = [
  { name: 'NODE_ENV', description: 'Node environment', default: 'development' },
  { name: 'DEBUG', description: 'Debug mode', default: 'false' }
];

// Count issues
let issues = 0;

// Check essential variables
console.log("\n--- ESSENTIAL VARIABLES ---");
essentialVars.forEach(variable => {
  const value = process.env[variable.name];
  
  if (!value) {
    console.error(`❌ ${variable.name}: NOT FOUND - ${variable.description}`);
    issues++;
  } else if (variable.name === 'TELEGRAM_API_HASH') {
    // Mask the API hash for security
    console.log(`✅ ${variable.name}: FOUND - [${value.substring(0, 4)}...${value.substring(value.length - 4)}]`);
  } else if (variable.name === 'MONGODB_URI') {
    // Mask the connection string for security
    const maskedUri = value.replace(/(mongodb(\+srv)?:\/\/)([^:]+):([^@]+)@/, '$1****:****@');
    console.log(`✅ ${variable.name}: FOUND - [${maskedUri}]`);
  } else {
    console.log(`✅ ${variable.name}: FOUND - [${value}]`);
  }
});

// Check additional variables
console.log("\n--- ADDITIONAL VARIABLES ---");
additionalVars.forEach(variable => {
  const value = process.env[variable.name];
  
  if (!value && variable.default) {
    console.log(`ℹ️ ${variable.name}: NOT FOUND - Using default: ${variable.default}`);
  } else if (!value) {
    console.log(`ℹ️ ${variable.name}: NOT FOUND - Optional`);
  } else {
    console.log(`✅ ${variable.name}: FOUND - [${value}]`);
  }
});

// Check if .env file exists
console.log("\n--- ENV FILE CHECK ---");
const rootDir = path.resolve(__dirname, '../../');
const envPath = path.join(rootDir, '.env');

if (fs.existsSync(envPath)) {
  console.log(`✅ .env file found at: ${envPath}`);
  
  // Read .env file to check for variable declarations
  const envContent = fs.readFileSync(envPath, 'utf8');
  const envLines = envContent.split('\n');
  const declaredVars = {};
  
  envLines.forEach(line => {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') return;
    
    // Extract variable name and value
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const [, name, value] = match;
      declaredVars[name.trim()] = value.trim();
    }
  });
  
  // Check if all essential variables are in .env file
  console.log("\n--- VARIABLES IN .ENV FILE ---");
  essentialVars.forEach(variable => {
    if (declaredVars[variable.name] === undefined) {
      console.error(`❌ ${variable.name}: NOT DECLARED in .env file`);
      issues++;
    } else if (declaredVars[variable.name] === '') {
      console.error(`❌ ${variable.name}: EMPTY in .env file`);
      issues++;
    } else if (variable.name === 'TELEGRAM_API_HASH') {
      const value = declaredVars[variable.name];
      console.log(`✅ ${variable.name}: DECLARED - [${value.substring(0, 4)}...${value.substring(value.length - 4)}]`);
    } else if (variable.name === 'MONGODB_URI') {
      const value = declaredVars[variable.name];
      const maskedUri = value.replace(/(mongodb(\+srv)?:\/\/)([^:]+):([^@]+)@/, '$1****:****@');
      console.log(`✅ ${variable.name}: DECLARED - [${maskedUri}]`);
    } else {
      console.log(`✅ ${variable.name}: DECLARED - [${declaredVars[variable.name]}]`);
    }
  });
} else {
  console.error(`❌ .env file NOT FOUND at: ${envPath}`);
  issues++;
}

// Check file permissions if on Linux/Mac
if (process.platform !== 'win32') {
  try {
    const stats = fs.statSync(envPath);
    const filePermissions = stats.mode.toString(8).slice(-3);
    console.log(`ℹ️ .env file permissions: ${filePermissions}`);
    
    // Check if file is readable only by owner
    if (filePermissions !== '600' && filePermissions !== '400') {
      console.warn(`⚠️ SECURITY WARNING: .env file permissions should be set to 600 (owner read/write only)`);
    }
  } catch (error) {
    // Ignore errors if file doesn't exist
  }
}

// Final report
console.log("\n======= ENVIRONMENT CHECK SUMMARY =======");
if (issues > 0) {
  console.error(`❌ Found ${issues} issue(s) with your environment configuration.`);
  console.error("Please fix the issues marked with ❌ above.");
} else {
  console.log("✅ All essential environment variables are properly configured.");
}

console.log("\nIMPORTANT: Make sure the TELEGRAM_API_ID is an integer value!");
console.log("If it's correctly configured in .env but still not working, make sure you're parsing it as an integer:");
console.log("parseInt(process.env.TELEGRAM_API_ID, 10)");

console.log("\n======= END OF ENVIRONMENT CHECK ======="); 