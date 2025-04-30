const Account = require('../models/Account');
const { addAccount } = require('../services/telegram/accountManager');
const logger = require('../utils/logger');

/**
 * Add a new Telegram account
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const addNewAccount = async (req, res) => {
  try {
    const accountData = req.body;
    
    // Add account
    const account = await addAccount(accountData);
    
    res.status(201).json({
      success: true,
      data: {
        id: account._id,
        username: account.username,
        phone_number: account.phone_number,
        status: account.status,
        max_channels: account.max_channels,
        current_channels_count: account.current_channels_count
      }
    });
  } catch (error) {
    logger.error(`API error adding account: ${error.message}`, {
      source: 'account-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get all Telegram accounts
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAllAccounts = async (req, res) => {
  try {
    const accounts = await Account.find({});
    
    res.status(200).json({
      success: true,
      count: accounts.length,
      data: accounts.map(account => ({
        id: account._id,
        username: account.username,
        phone_number: account.phone_number,
        status: account.status,
        last_active: account.last_active,
        max_channels: account.max_channels,
        current_channels_count: account.current_channels_count,
        created_at: account.created_at
      }))
    });
  } catch (error) {
    logger.error(`API error getting accounts: ${error.message}`, {
      source: 'account-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get a specific account by ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAccountById = async (req, res) => {
  try {
    const account = await Account.findById(req.params.id);
    
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Account not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        id: account._id,
        username: account.username,
        phone_number: account.phone_number,
        status: account.status,
        last_active: account.last_active,
        max_channels: account.max_channels,
        current_channels_count: account.current_channels_count,
        created_at: account.created_at,
        updated_at: account.updated_at
      }
    });
  } catch (error) {
    logger.error(`API error getting account by ID: ${error.message}`, {
      source: 'account-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  addNewAccount,
  getAllAccounts,
  getAccountById
}; 