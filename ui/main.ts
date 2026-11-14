import { APP_VERSION } from '../core/model/version';

const versionEl = document.getElementById('app-version');
if (versionEl) versionEl.textContent = `v${APP_VERSION}`;
