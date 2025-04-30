const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    logger.info(`MongoDB Connected: ${conn.connection.host}`, { source: 'database' });
    return conn;
  } catch (error) {
    logger.error(`Error connecting to MongoDB: ${error.message}`, { 
      source: 'database',
      context: { error: error.stack }
    });
    process.exit(1);
  }
};

module.exports = connectDB; 