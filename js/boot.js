// Runs before first paint so the saved theme applies without a flash.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('quillshift.settings') || '{}');
    if (s.theme === 'light' || s.theme === 'dark') document.documentElement.dataset.theme = s.theme;
  } catch (e) {}
})();
