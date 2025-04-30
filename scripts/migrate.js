require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');

// Connect to database
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  logger.info('Connected to MongoDB for migration');
  
  try {
    // Add migration logic here
    // For example:
    // await db.collection('accounts').updateMany({}, { $set: { new_field: 'default_value' } });
    
    logger.info('Migration completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error(`Error during migration: ${error.message}`, {
      context: { error: error.stack }
    });
    process.exit(1);
  }
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
}); 