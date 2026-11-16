// Shell-level helpers that more than one view needs.

import { settings } from './store.js';
import { openSheet, icon, isIOS } from './ui.js';

export function applyTheme() {
  const t = settings.get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

export function showInstallHelp() {
  const ios = isIOS();
  openSheet({
    title: 'Install Quillshift',
    body: ios
      ? `<p class="muted">Add Quillshift to your Home Screen to use it full-screen and offline, like any other app.</p>
         <ol class="steps"><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button ${icon('share')}.</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>.</li></ol>`
      : `<p class="muted">Install Quillshift to use it full-screen and offline, like any other app.</p>
         <ol class="steps"><li>Open your browser menu (<b>⋮</b> or <b>⋯</b>).</li><li>Choose <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Confirm with <b>Install</b>.</li></ol>
         <p class="small muted">On a computer, look for the install icon at the right of the address bar.</p>`,
  });
}
