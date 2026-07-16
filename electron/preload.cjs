const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  localPickFiles: () => ipcRenderer.invoke('local-pick-files'),
  localPickFolder: () => ipcRenderer.invoke('local-pick-folder'),
  localFileUrl: (filePath) => ipcRenderer.invoke('local-file-url', filePath),
  localReadAudio: (filePath) => ipcRenderer.invoke('local-read-audio', filePath),
  localEnrichMeta: (paths) => ipcRenderer.invoke('local-enrich-meta', paths),
  localCoverForPath: (filePath) => ipcRenderer.invoke('local-cover-for-path', filePath),
  localRevealInFolder: (filePath) => ipcRenderer.invoke('local-reveal-in-folder', filePath),
  localCheckMissing: (paths) => ipcRenderer.invoke('local-check-missing', paths),
  localScanFolder: (folderPath) => ipcRenderer.invoke('local-scan-folder', folderPath),
  localWatchFolders: (folders) => ipcRenderer.invoke('local-watch-folders', folders),
  localReadLyricsFile: (filePath) => ipcRenderer.invoke('local-read-lyrics-file', filePath),
  localImportM3u: () => ipcRenderer.invoke('local-import-m3u'),
  localExportM3u: (content) => ipcRenderer.invoke('local-export-m3u', content),
  localWriteTags: (payload) => ipcRenderer.invoke('local-write-tags', payload),
  localOpenMiniPlayer: () => ipcRenderer.invoke('local-open-mini-player'),
  localPickFolderWatch: () => ipcRenderer.invoke('local-pick-folder-watch'),
  onLocalLibraryEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('local-library-event', handler);
    return () => ipcRenderer.removeListener('local-library-event', handler);
  },

  playerPushState: (state) => ipcRenderer.invoke('player-push-state', state),
  playerGetState: () => ipcRenderer.invoke('player-get-state'),
  onPlayerState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('player-state', handler);
    return () => ipcRenderer.removeListener('player-state', handler);
  },

  mediaCommand: (cmd) => ipcRenderer.invoke('media-command', cmd),
  resolveClientId: () => ipcRenderer.invoke('resolve-client-id'),
  authGet: () => ipcRenderer.invoke('auth-get'),
  authLogin: (opts) => ipcRenderer.invoke('auth-login', opts),
  authLogout: () => ipcRenderer.invoke('auth-logout'),
  authSave: (payload) => ipcRenderer.invoke('auth-save', payload),
  authImportToken: (payload) => ipcRenderer.invoke('auth-import-token', payload),
  openExternalSc: () => ipcRenderer.invoke('open-external-sc'),
  authHelperUrl: () => ipcRenderer.invoke('auth-helper-url'),
  onAuthChanged: (callback) => {
    const handler = (_event, session) => callback(session);
    ipcRenderer.on('auth-changed', handler);
    return () => ipcRenderer.removeListener('auth-changed', handler);
  },
  profileState: () => ipcRenderer.invoke('profile-state'),
  profileCreate: (payload) => ipcRenderer.invoke('profile-create', payload),
  profileUpdate: (payload) => ipcRenderer.invoke('profile-update', payload), // displayName, bio, accent, avatarPath
  profileSwitch: (profileId) => ipcRenderer.invoke('profile-switch', profileId),
  profileLogout: () => ipcRenderer.invoke('profile-logout'),
  profileDelete: (profileId) => ipcRenderer.invoke('profile-delete', profileId),
  profilePickAvatar: () => ipcRenderer.invoke('profile-pick-avatar'),
  profilePickBanner: () => ipcRenderer.invoke('profile-pick-banner'),
  onMediaCommand: (callback) => {
    const handler = (_event, cmd) => callback(cmd);
    ipcRenderer.on('media-command', handler);
    return () => ipcRenderer.removeListener('media-command', handler);
  },
  proxyGet: () => ipcRenderer.invoke('proxy-get'),
  proxySet: (cfg) => ipcRenderer.invoke('proxy-set', cfg),
  proxyTest: () => ipcRenderer.invoke('proxy-test'),
  proxyProbeLocal: () => ipcRenderer.invoke('proxy-probe-local'),
  discordGet: () => ipcRenderer.invoke('discord-get'),
  discordSetConfig: (cfg) => ipcRenderer.invoke('discord-set-config', cfg),
  discordSetPresence: (payload) => ipcRenderer.invoke('discord-set-presence', payload),
  discordClearPresence: () => ipcRenderer.invoke('discord-clear-presence'),
  apiFetch: (payload) => ipcRenderer.invoke('api-fetch', payload),
  apiUpload: (payload) => ipcRenderer.invoke('api-upload', payload),

  mediaFetch: (payload) => ipcRenderer.invoke('media-fetch', payload),

  ytFetch: (payload) => ipcRenderer.invoke('yt-fetch', payload),

  ytResolveAudio: (videoId) => ipcRenderer.invoke('yt-resolve-audio', videoId),

  ytPagePlay: (payload) => ipcRenderer.invoke('yt-page-play', payload),
  ytPageCommand: (payload) => ipcRenderer.invoke('yt-page-command', payload),

  scEmbedPlay: (payload) => ipcRenderer.invoke('sc-embed-play', payload),
  scEmbedCommand: (payload) => ipcRenderer.invoke('sc-embed-command', payload),
});
