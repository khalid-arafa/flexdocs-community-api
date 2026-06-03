function timeAgo(date) {
  const units = { year: 31536000, month: 2592000, day: 86400, hour: 3600, minute: 60, second: 1 };
  const diff = Math.floor((new Date() - new Date(date)) / 1000);
  for (let [unit, seconds] of Object.entries(units)) {
    const interval = Math.floor(diff / seconds);
    if (interval >= 1) return `${interval} ${unit}${interval > 1 ? 's' : ''} ago`;
  }
  return "just now";
}

module.exports = { timeAgo };