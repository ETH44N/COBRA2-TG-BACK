// Dashboard JavaScript

document.addEventListener('DOMContentLoaded', function() {
  
  // Initialize tooltips
  const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
  tooltipTriggerList.map(function (tooltipTriggerEl) {
    return new bootstrap.Tooltip(tooltipTriggerEl);
  });
  
  // Add sorting functionality to table headers with sort links
  const sortLinks = document.querySelectorAll('th a[href*="sort="]');
  sortLinks.forEach(link => {
    link.addEventListener('click', function(e) {
      // Add active class to the clicked sort link
      sortLinks.forEach(l => l.parentElement.classList.remove('sort-active'));
      this.parentElement.classList.add('sort-active');
    });
  });
  
  // Add filter functionality to filter buttons
  const filterButtons = document.querySelectorAll('.btn-group a.btn');
  filterButtons.forEach(button => {
    button.addEventListener('click', function() {
      filterButtons.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
    });
  });
  
  // Function to format relative time (like "2 hours ago")
  window.formatRelativeTime = function(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    
    if (diffDay > 0) {
      return diffDay + ' day' + (diffDay > 1 ? 's' : '') + ' ago';
    } else if (diffHour > 0) {
      return diffHour + ' hour' + (diffHour > 1 ? 's' : '') + ' ago';
    } else if (diffMin > 0) {
      return diffMin + ' minute' + (diffMin > 1 ? 's' : '') + ' ago';
    } else {
      return 'Just now';
    }
  }
  
  // Update all relative times on the page
  function updateRelativeTimes() {
    const timeElements = document.querySelectorAll('.relative-time');
    timeElements.forEach(el => {
      const timestamp = el.getAttribute('data-timestamp');
      if (timestamp) {
        el.textContent = formatRelativeTime(timestamp);
      }
    });
  }
  
  // Initially update times and then every minute
  updateRelativeTimes();
  setInterval(updateRelativeTimes, 60000);
}); 