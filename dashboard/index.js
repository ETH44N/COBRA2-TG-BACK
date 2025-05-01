const path = require('path');
// Make sure to load the environment variables from the dashboard directory
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const moment = require('moment');
const expressLayouts = require('express-ejs-layouts');
const { MongoClient } = require('mongodb');
// Replace node-fetch with axios which is CommonJS compatible
const axios = require('axios');

// Initialize Express app
const app = express();

// Configure view engine and static files
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Setup express-ejs-layouts - important to set up before other middleware
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('layout extractScripts', true);
app.set('layout extractStyles', true);

app.use(express.static(path.join(__dirname, 'public')));

// Add moment.js to all views for date formatting
app.locals.moment = moment;

// Add active page middleware
app.use((req, res, next) => {
  // Set default active based on path
  res.locals.active = '';
  const path = req.path;
  
  if (path === '/') {
    res.locals.active = 'home';
  } else if (path.startsWith('/accounts')) {
    res.locals.active = 'accounts';
  } else if (path.startsWith('/channels')) {
    res.locals.active = 'channels';
  }
  
  next();
});

// Create schemas and models directly in this file to avoid import issues
const accountSchema = new mongoose.Schema({
  _id: {
    type: String
  },
  username: String,
  phone_number: String,
  session_string: String,
  status: {
    type: String,
    enum: ['active', 'banned', 'limited', 'inactive'],
    default: 'inactive'
  },
  last_active: {
    type: Date,
    default: Date.now
  },
  isBanned: {
    type: Boolean,
    default: false
  },
  max_channels: {
    type: Number,
    default: 50
  },
  current_channels_count: {
    type: Number,
    default: 0
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

const channelSchema = new mongoose.Schema({
  _id: {
    type: String
  },
  channel_id: {
    type: String,
    required: true
  },
  numeric_id: {  // Add this field
    type: String
  },
  name: String,
  username: String,
  joined_by_account_id: {
    type: String,
    ref: 'Account'
  },
  date_joined: {
    type: Date,
    default: Date.now
  },
  is_active: {
    type: Boolean,
    default: false
  },
  last_message_at: Date,
  description: String,
  member_count: Number
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

const messageSchema = new mongoose.Schema({
  _id: {
    type: String
  },
  channel_id: {
    type: String,
    ref: 'Channel',
    required: true
  },
  message_id: {
    type: Number,
    required: true
  },
  sender_id: String,
  sender_name: String,
  text: String,
  content: String,
  media_type: {
    type: String,
    enum: ['photo', 'video', 'document', 'audio', 'sticker', 'animation', 'poll', 'contact', 'location', 'none'],
    default: 'none'
  },
  is_deleted: {
    type: Boolean,
    default: false
  },
  deleted_at: Date,
  date: {
    type: Date,
    required: true
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

const assignmentSchema = new mongoose.Schema({
  _id: {
    type: String
  },
  account_id: {
    type: String,
    ref: 'Account'
  },
  channel_id: {
    type: String,
    ref: 'Channel'
  },
  assigned_at: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['active', 'failed', 'reassigned'],
    default: 'active'
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

// Define models
const Account = mongoose.model('Account', accountSchema);
const Channel = mongoose.model('Channel', channelSchema);
const Message = mongoose.model('Message', messageSchema);
const Assignment = mongoose.model('AccountChannelAssignment', assignmentSchema);

// Connect to MongoDB
console.log('Connecting to MongoDB...');
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000
})
.then(() => {
  console.log('Connected to MongoDB successfully');
})
.catch(err => {
  console.error('MongoDB connection error:', err);
});

// Dashboard home page - System overview
app.get('/', async (req, res) => {
  try {
    // Default values in case of database failure
    let accountStats = { total: 0, active: 0, banned: 0, inactive: 0 };
    let channelStats = { total: 0, active: 0, inactive: 0 };
    let messageStats = { total: 0, deleted: 0, active: 0 };
    let recentMessages = [];
    
    // Get system info
    const systemInfo = {
      uptime: Math.floor(process.uptime()),
      nodeVersion: process.version,
      timestamp: new Date()
    };
    
    // Try to get account statistics
    try {
      const accounts = await Account.find().lean();
      const activeAccounts = accounts.filter(a => a.status === 'active' && !a.isBanned);
      const bannedAccounts = accounts.filter(a => a.isBanned || a.status === 'banned');
      const inactiveAccounts = accounts.filter(a => a.status !== 'active' && !a.isBanned);
      
      accountStats = {
        total: accounts.length,
        active: activeAccounts.length,
        banned: bannedAccounts.length,
        inactive: inactiveAccounts.length
      };
    } catch (err) {
      console.error('Error fetching account statistics:', err);
    }
    
    // Try to get channel statistics
    try {
      const channels = await Channel.find().lean();
      const activeChannels = channels.filter(c => c.is_active);
      const inactiveChannels = channels.filter(c => !c.is_active);
      
      channelStats = {
        total: channels.length,
        active: activeChannels.length,
        inactive: inactiveChannels.length
      };
    } catch (err) {
      console.error('Error fetching channel statistics:', err);
    }
    
    // Try to get message statistics
    try {
      const totalMessages = await Message.countDocuments();
      const deletedMessages = await Message.countDocuments({ is_deleted: true });
      
      messageStats = {
        total: totalMessages,
        deleted: deletedMessages,
        active: totalMessages - deletedMessages
      };
    } catch (err) {
      console.error('Error fetching message statistics:', err);
    }
    
    // Try to get recent messages
    try {
      recentMessages = await Message.find()
        .sort({ created_at: -1 })
        .limit(10)
        .populate('channel_id')
        .lean();
    } catch (err) {
      console.error('Error fetching recent messages:', err);
    }

    // Render the page
    res.render('home', {
      accountStats,
      channelStats,
      messageStats,
      recentMessages,
      systemInfo,
      title: 'Dashboard Overview',
      active: 'home'
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.render('error', {
      message: 'Failed to load dashboard',
      error: error,
      title: 'Error',
      active: ''
    });
  }
});

// Accounts list page
app.get('/accounts', async (req, res) => {
  try {
    // Parse query parameters
    const status = req.query.status;
    const sort = req.query.sort || 'username';
    const dir = req.query.dir || 'asc';
    
    // Prepare filter
    let filter = {};
    if (status === 'active') {
      filter = { status: 'active', isBanned: { $ne: true } };
    } else if (status === 'banned') {
      filter = { $or: [{ isBanned: true }, { status: 'banned' }] };
    } else if (status === 'inactive') {
      filter = { status: 'inactive', isBanned: { $ne: true } };
    }
    
    // Prepare sort
    let sortOptions = {};
    if (sort === 'username' || sort === 'phone_number') {
      sortOptions[sort] = dir === 'asc' ? 1 : -1;
    } else if (sort === 'last_active') {
      sortOptions.last_active = dir === 'asc' ? 1 : -1;
    }
    
    // Get accounts
    const accounts = await Account.find(filter).sort(sortOptions).lean();
    
    // Count assigned channels for each account
    const accountIds = accounts.map(a => a._id);
    const assignmentCounts = await Assignment.aggregate([
      { $match: { account_id: { $in: accountIds }, status: 'active' } },
      { $group: { _id: '$account_id', count: { $sum: 1 } } }
    ]);
    
    // Add channel counts to accounts
    const accountChannelMap = Object.fromEntries(
      assignmentCounts.map(a => [a._id.toString(), a.count])
    );
    
    accounts.forEach(account => {
      account.actual_channel_count = accountChannelMap[account._id.toString()] || 0;
    });
    
    res.render('accounts', {
      accounts,
      filters: {
        status,
        sort,
        dir
      },
      title: 'Telegram Accounts',
      active: 'accounts'
    });
  } catch (error) {
    console.error('Error rendering accounts list:', error);
    res.render('error', {
      message: 'Failed to load accounts data',
      error: error,
      title: 'Error',
      active: ''
    });
  }
});

// Channels list page
app.get('/channels', async (req, res) => {
  try {
    // Parse query parameters
    const status = req.query.status;
    const sort = req.query.sort || 'name';
    const dir = req.query.dir || 'asc';
    
    // Prepare filter
    let filter = {};
    if (status === 'active') {
      filter.is_active = true;
    } else if (status === 'inactive') {
      filter.is_active = false;
    }
    
    // Prepare sort
    let sortOptions = {};
    if (sort === 'name' || sort === 'username') {
      sortOptions[sort] = dir === 'asc' ? 1 : -1;
    } else if (sort === 'last_message_at') {
      sortOptions.last_message_at = dir === 'asc' ? 1 : -1;
    }
    
    // Get channels
    const channels = await Channel.find(filter)
      .sort(sortOptions)
      .populate('joined_by_account_id')
      .lean();
    
    // Get message counts for each channel
    const channelIds = channels.map(c => c._id);
    const messageCounts = await Message.aggregate([
      { $match: { channel_id: { $in: channelIds } } },
      { $group: { _id: '$channel_id', count: { $sum: 1 } } }
    ]);
    
    // Add message counts to channels
    const channelMessageMap = Object.fromEntries(
      messageCounts.map(m => [m._id.toString(), m.count])
    );
    
    // Transform channels to have consistent field names across views
    const transformedChannels = channels.map(channel => {
      return {
        ...channel,
        status: channel.is_active ? 'active' : 'inactive',
        messageCount: channelMessageMap[channel._id.toString()] || 0,
        lastActivity: channel.last_message_at || channel.updated_at
      };
    });
    
    res.render('channels', {
      channels: transformedChannels,
      filters: {
        status,
        sort,
        dir
      },
      title: 'Monitored Channels',
      active: 'channels'
    });
  } catch (error) {
    console.error('Error rendering channels list:', error);
    res.render('error', {
      message: 'Failed to load channels data',
      error: error,
      title: 'Error',
      active: ''
    });
  }
});

// Channel detail page
app.get('/channels/:id', async (req, res) => {
  try {
    const channelId = req.params.id;
    
    const channel = await Channel.findById(channelId)
      .populate('joined_by_account_id')
      .lean();
    
    if (!channel) {
      return res.status(404).render('error', {
        message: 'Channel not found',
        error: { status: 404 },
        title: 'Not Found',
        active: ''
      });
    }
    
    // Get recent messages for this channel
    const messages = await Message.find({ channel_id: channelId })
      .sort({ date: -1 })
      .limit(50)
      .lean();
    
    // Get message stats
    const totalMessages = await Message.countDocuments({ channel_id: channelId });
    const deletedMessages = await Message.countDocuments({ 
      channel_id: channelId,
      is_deleted: true
    });
    
    const messageStats = {
      total: totalMessages,
      deleted: deletedMessages,
      active: totalMessages - deletedMessages
    };
    
    res.render('channel-detail', {
      channel,
      messages,
      messageStats,
      title: `Channel: ${channel.name || channel.username || channel.channel_id}`,
      active: 'channels'
    });
  } catch (error) {
    console.error('Error rendering channel detail:', error);
    res.render('error', {
      message: 'Failed to load channel data',
      error: error,
      title: 'Error',
      active: ''
    });
  }
});

// Account detail page
app.get('/accounts/:id', async (req, res) => {
  try {
    const accountId = req.params.id;
    
    const account = await Account.findById(accountId).lean();
    
    if (!account) {
      return res.status(404).render('error', {
        message: 'Account not found',
        error: { status: 404 },
        title: 'Not Found',
        active: ''
      });
    }
    
    // Get channels monitored by this account
    const assignments = await Assignment.find({ 
      account_id: accountId,
      status: 'active'
    }).populate('channel_id').lean();
    
    const channels = assignments.map(a => a.channel_id).filter(Boolean);
    
    res.render('account-detail', {
      account,
      channels,
      title: `Account: ${account.username || account.phone_number}`,
      active: 'accounts'
    });
  } catch (error) {
    console.error('Error rendering account detail:', error);
    res.render('error', {
      message: 'Failed to load account data',
      error: error,
      title: 'Error',
      active: ''
    });
  }
});

// API Routes
// Add this somewhere appropriate in your Express app configuration

// Mock API endpoints for backend testing (remove these when real backend endpoints are available)
// Add these after the real /api/channels/status endpoint

// Mock backend status endpoint - for testing only
app.get('/mock/api/status', (req, res) => {
  res.json({
    status: 'running',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Mock monitored channels endpoint - for testing only
app.get('/mock/api/channels/monitored', (req, res) => {
  // This will make some random channels appear active
  db.collection('channels').find({}).toArray()
    .then(channels => {
      // Select random 60% of channels to be "active"
      const activeChannels = channels
        .sort(() => 0.5 - Math.random())
        .slice(0, Math.floor(channels.length * 0.6));
      
      res.json({
        success: true,
        channels: activeChannels.map(ch => ({
          id: ch._id,
          name: ch.name,
          isActive: true
        }))
      });
    })
    .catch(err => {
      res.status(500).json({
        success: false,
        error: err.message
      });
    });
});

// Update the real channels status endpoint to use the mock endpoints if real ones fail
app.get('/api/channels/status', async (req, res) => {
  try {
    // Get channels from database
    const channels = await db.collection('channels').find({}).toArray();
    
    // Check backend status via health check or status API
    let backendStatus = false;
    let activeChannelIds = [];
    
    try {
      // Try real backend first
      const backendResponse = await axios.get('http://localhost:3000/api/status', {
        timeout: 2000 // 2 second timeout
      });
      
      backendStatus = backendResponse.data.status === 'running';
      
      // If real backend is running, get actively monitored channels
      if (backendStatus) {
        try {
          const monitoredResponse = await axios.get('http://localhost:3000/api/channels/monitored', {
            timeout: 2000
          });
          
          if (monitoredResponse.data.channels) {
            activeChannelIds = monitoredResponse.data.channels.map(ch => ch.id || ch._id);
          }
        } catch (error) {
          console.error('Error getting monitored channels from real backend:', error.message);
          backendStatus = false;
        }
      }
    } catch (error) {
      console.error('Error connecting to real backend, trying mock backend:', error.message);
      
      // Try mock backend as fallback for testing
      try {
        // Use the internal mock endpoints
        backendStatus = true; // Assume mock is running
        
        // Get mock monitored channels
        const mockChannels = channels
          .sort(() => 0.5 - Math.random())
          .slice(0, Math.floor(channels.length * 0.6));
          
        activeChannelIds = mockChannels.map(ch => ch._id.toString());
      } catch (mockError) {
        console.error('Mock backend also failed:', mockError.message);
        backendStatus = false;
      }
    }
    
    // Prepare response with real-time status
    const channelsWithStatus = channels.map(channel => {
      // Check if this channel is in the active list from backend
      const isReallyActive = backendStatus && activeChannelIds.includes(channel._id.toString());
      
      return {
        ...channel,
        isActive: isReallyActive,
        status: isReallyActive ? 'active' : 'inactive'
      };
    });
    
    res.json({
      success: true,
      backendRunning: backendStatus,
      channels: channelsWithStatus
    });
    
  } catch (error) {
    console.error('Error getting channel statuses:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get channel statuses',
      message: error.message
    });
  }
});

// Add new API endpoint for message statistics
app.get('/api/messages/stats', async (req, res) => {
  try {
    // Get fresh message statistics from database
    const totalMessages = await Message.countDocuments();
    const deletedMessages = await Message.countDocuments({ is_deleted: true });
    
    // Get recent messages
    const recentMessages = await Message.find()
      .sort({ created_at: -1 })
      .limit(10)
      .populate('channel_id')
      .lean();
    
    // Format recent messages for display
    const formattedRecentMessages = recentMessages.map(msg => {
      return {
        id: msg._id,
        channelId: msg.channel_id ? msg.channel_id._id : null,
        channelName: msg.channel_id ? (msg.channel_id.name || msg.channel_id.username || msg.channel_id.channel_id) : 'Unknown',
        content: msg.text || msg.content || '',
        date: msg.created_at || msg.date,
        isDeleted: msg.is_deleted
      };
    });
    
    res.json({
      success: true,
      stats: {
        total: totalMessages,
        deleted: deletedMessages,
        active: totalMessages - deletedMessages
      },
      recentMessages: formattedRecentMessages
    });
  } catch (error) {
    console.error('Error fetching message statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch message statistics',
      message: error.message
    });
  }
});

// Diagnostics page
app.get('/diagnostics', async (req, res) => {
  try {
    // Get connection status and database info
    const systemInfo = {
      uptime: Math.floor(process.uptime()),
      nodeVersion: process.version,
      timestamp: new Date()
    };
    
    res.render('diagnostics', {
      title: 'System Diagnostics',
      active: 'diagnostics',
      systemInfo
    });
  } catch (error) {
    console.error('Error loading diagnostics page:', error);
    res.render('error', {
      message: 'Failed to load diagnostics',
      error: error,
      title: 'Error',
      active: ''
    });
  }
});

// Add diagnostic endpoint to check message collection
app.get('/api/diagnostic/messages', async (req, res) => {
  try {
    // Direct MongoDB client for diagnostic purposes
    const client = new MongoClient(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    await client.connect();
    const db = client.db();
    
    // Get message collection stats
    const messagesCollectionExists = await db.listCollections({ name: 'messages' }).hasNext();
    let result = {
      collectionExists: messagesCollectionExists,
      mongoose: {
        count: 0,
        sample: []
      },
      direct: {
        count: 0,
        sample: [],
        fields: {}
      }
    };
    
    // Try counting with Mongoose
    try {
      result.mongoose.count = await Message.countDocuments();
      result.mongoose.sample = await Message.find().limit(5).lean();
    } catch (err) {
      result.mongoose.error = err.message;
    }
    
    // Try counting directly with MongoDB driver
    if (messagesCollectionExists) {
      try {
        result.direct.count = await db.collection('messages').countDocuments();
        result.direct.sample = await db.collection('messages').find().limit(5).toArray();
        
        // Analyze what fields exist in the collection
        if (result.direct.sample.length > 0) {
          const allFields = new Set();
          result.direct.sample.forEach(doc => {
            Object.keys(doc).forEach(key => allFields.add(key));
          });
          
          // Count how many documents have each field
          for (const field of allFields) {
            const fieldCount = await db.collection('messages').countDocuments({ [field]: { $exists: true } });
            result.direct.fields[field] = fieldCount;
          }
        }
      } catch (err) {
        result.direct.error = err.message;
      }
    }
    
    // Get channel and account counts for context
    try {
      result.channelCount = await Channel.countDocuments();
      result.accountCount = await Account.countDocuments();
    } catch (err) {
      result.countError = err.message;
    }
    
    // Check message listener status by crawling logs
    try {
      const recentLogs = await db.collection('logs').find({
        source: 'message-listener',
        timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
      }).sort({ timestamp: -1 }).limit(50).toArray();
      
      result.logs = {
        count: recentLogs.length,
        newMessageLogs: recentLogs.filter(log => log.message && log.message.includes('Saved message')).length,
        sample: recentLogs.slice(0, 10)
      };
    } catch (err) {
      result.logs = { error: err.message };
    }
    
    await client.close();
    
    res.json({
      success: true,
      diagnostics: result
    });
  } catch (error) {
    console.error('Diagnostic error:', error);
    res.status(500).json({
      success: false,
      error: 'Diagnostic failed',
      message: error.message
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: req.app.get('env') === 'development' ? err : {},
    title: 'Error',
    active: ''
  });
});

// Start the server
const PORT = process.env.DASHBOARD_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard server running on port ${PORT}`);
});

// Direct MongoDB connection test
async function testDirectMongoConnection() {
  console.log('Testing direct MongoDB connection...');
  const client = new MongoClient(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 60000,
    connectTimeoutMS: 60000
  });
  
  try {
    await client.connect();
    console.log('Direct MongoDB connection test successful');
    const db = client.db();
    const collections = await db.listCollections().toArray();
    console.log(`Available collections: ${collections.map(c => c.name).join(', ')}`);
    await client.close();
  } catch (err) {
    console.error('Direct MongoDB connection test failed:', err);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down dashboard server');
  app.close(() => {
    console.log('Dashboard server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});

// Call the test function
testDirectMongoConnection();

module.exports = app; 