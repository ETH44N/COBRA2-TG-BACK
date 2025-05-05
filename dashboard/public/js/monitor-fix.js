// Monitor page fix
console.log('Monitor fix script loaded');

// Function to log any errors that occur
window.onerror = function(message, source, lineno, colno, error) {
  console.error('Error caught by monitor-fix.js:', message, 'at', source, ':', lineno, ':', colno, error);
  return false;
};

// Ensure DOM is ready before executing code
window.onload = function() {
  console.log('Window loaded, initializing monitor page...');
  
  try {
    // Initialize page
    loadMonitoringStatus();
    loadRecentLogs();

    // Refresh buttons
    document.getElementById('refresh-status').addEventListener('click', loadMonitoringStatus);
    document.getElementById('refresh-logs-btn').addEventListener('click', loadRecentLogs);
    
    // Fix buttons
    document.getElementById('fix-listeners-btn').addEventListener('click', fixAllChannelListeners);
    document.getElementById('fix-numeric-ids-btn').addEventListener('click', fixAllNumericIds);
    
    // Channel search
    document.getElementById('check-channel-btn').addEventListener('click', checkSpecificChannel);
    
    // Log search
    const logSearchInput = document.getElementById('log-search');
    logSearchInput.addEventListener('keyup', filterLogs);
    document.getElementById('clear-log-search').addEventListener('click', clearLogSearch);
    
    // Auto-refresh every 30 seconds
    setInterval(loadMonitoringStatus, 30000);
    setInterval(loadRecentLogs, 30000);
    
    console.log('Monitor page initialized successfully');
  } catch (err) {
    console.error('Error initializing monitor page:', err);
  }
};

// Make sure this script loads even if there are other errors
console.log('Monitor fix script completed loading'); 