/// <reference types="vite/client" />

import type { AuthSession } from './types';
import type { MiuraProfileState } from './lib/miuraProfile';

declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}

export interface ProxyConfig {
  enabled: boolean;
  mode: 'sc' | 'all';
  url: string;
}

export interface DiscordPresencePayload {
  title: string;
  artist?: string;
  artworkUrl?: string;
  permalink?: string;
  
  duration?: number;
  
  progress?: number;
  playing?: boolean;
}

export interface DiscordStatus {
  enabled: boolean;
  clientId: string;
  ready: boolean;
  connected: boolean;
  hasPackage: boolean;
  needsClientId: boolean;
}

declare global {
interface Window {
  electronAPI?: {
    getAppVersion: () => Promise<string>;
    titlebarSetTheme?: (theme: 'black' | 'gray' | 'white' | string) => Promise<{ ok: boolean; error?: string }>;
    windowMinimize?: () => Promise<{ ok: boolean; error?: string }>;
    windowMaximizeToggle?: () => Promise<{ ok: boolean; maximized?: boolean; error?: string }>;
    windowClose?: () => Promise<{ ok: boolean; error?: string }>;
    windowIsMaximized?: () => Promise<{ ok: boolean; maximized?: boolean }>;
    onWindowMaximized?: (callback: (maximized: boolean) => void) => () => void;
    localPickFiles: () => Promise<
      Array<{ path: string; name: string; size?: number; url?: string }> | { error: string }
    >;
    localPickFolder: () => Promise<
      Array<{ path: string; name: string; size?: number; url?: string }> | { error: string }
    >;
    localFileUrl: (
      filePath: string
    ) => Promise<
      | { ok: true; url: string; path: string; mime: string; size: number }
      | { ok: false; error: string }
    >;
    localReadAudio: (
      filePath: string
    ) => Promise<
      | { ok: true; buffer: ArrayBuffer | Uint8Array; mime: string; size: number; path: string }
      | { ok: false; error: string }
    >;
    localEnrichMeta: (paths: string[]) => Promise<
      | Array<{
          path: string;
          name: string;
          title?: string;
          artist?: string;
          album?: string | null;
          durationMs?: number | null;
          artworkUrl?: string | null;
          size?: number;
          url?: string;
        }>
      | { error: string }
    >;
    localCoverForPath: (
      filePath: string
    ) => Promise<{ ok: true; dataUrl: string } | { ok: false; error?: string }>;
    localRevealInFolder: (
      filePath: string
    ) => Promise<{ ok: boolean; error?: string }>;
    localCheckMissing: (
      paths: string[]
    ) => Promise<{
      ok: boolean;
      missing?: string[];
      present?: string[];
      error?: string;
    }>;
    localScanFolder: (
      folderPath: string
    ) => Promise<
      Array<Record<string, unknown>> | { error: string }
    >;
    localWatchFolders: (
      folders: string[]
    ) => Promise<{ ok: boolean; watching?: string[]; error?: string }>;
    localReadLyricsFile: (
      filePath: string
    ) => Promise<{ ok: boolean; text?: string; path?: string; error?: string }>;
    localImportM3u: () => Promise<{
      ok: boolean;
      canceled?: boolean;
      text?: string;
      path?: string;
      baseDir?: string;
      error?: string;
    }>;
    localExportM3u: (
      content: string
    ) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    localWriteTags: (payload: {
      path: string;
      title?: string;
      artist?: string;
      album?: string | null;
      genre?: string | null;
      year?: number | null;
    }) => Promise<{ ok: boolean; written?: boolean; note?: string; error?: string }>;
    localOpenMiniPlayer: () => Promise<{ ok: boolean; error?: string }>;
    localPickFolderWatch: () => Promise<{
      ok: boolean;
      canceled?: boolean;
      path?: string;
      error?: string;
    }>;
    onLocalLibraryEvent: (
      callback: (payload: {
        type: string;
        folder?: string;
        file?: string;
        eventType?: string;
      }) => void
    ) => () => void;
    playerPushState: (state: {
      title?: string;
      artist?: string;
      playing?: boolean;
      artworkUrl?: string | null;
    }) => Promise<{ ok: boolean; error?: string }>;
    playerGetState: () => Promise<{
      ok?: boolean;
      title?: string;
      artist?: string;
      playing?: boolean;
      artworkUrl?: string | null;
    }>;
    onPlayerState: (
      callback: (state: {
        title?: string;
        artist?: string;
        playing?: boolean;
        artworkUrl?: string | null;
      }) => void
    ) => () => void;
    mediaCommand: (cmd: 'toggle' | 'next' | 'prev' | string) => Promise<{ ok: boolean; error?: string }>;
    resolveClientId: () => Promise<string>;
    authGet: () => Promise<AuthSession | null>;
    authLogin: (opts?: { mode?: 'app' | 'browser' }) => Promise<AuthSession>;
    authLogout: () => Promise<boolean>;
    authSave: (payload: {
      accessToken: string;
      clientId?: string | null;
      user?: AuthSession['user'];
    }) => Promise<AuthSession | null>;
    authImportToken: (payload: {
      accessToken: string;
      clientId?: string | null;
    }) => Promise<AuthSession | null>;
    openExternalSc: () => Promise<boolean>;
    authHelperUrl: () => Promise<string>;
    onAuthChanged: (callback: (session: AuthSession | null) => void) => () => void;
    profileState: () => Promise<MiuraProfileState>;
    profileCreate: (payload: {
      displayName: string;
      avatarPath?: string;
      bio?: string;
      accent?: string | null;
    }) => Promise<MiuraProfileState>;
    profileUpdate: (payload: {
      id: string;
      displayName?: string;
      bio?: string;
      accent?: string | null;
      avatarPath?: string;
      bannerPath?: string;
      bannerPosX?: number;
      bannerPosY?: number;
      clearAvatar?: boolean;
      clearBanner?: boolean;
    }) => Promise<MiuraProfileState>;
    profileSwitch: (profileId: string) => Promise<MiuraProfileState>;
    profileLogout: () => Promise<MiuraProfileState>;
    profileDelete: (profileId: string) => Promise<MiuraProfileState>;
    profilePickAvatar: () => Promise<{
      canceled: boolean;
      path?: string;
      dataUrl?: string;
      error?: string;
    }>;
    profilePickBanner: () => Promise<{
      canceled: boolean;
      path?: string;
      dataUrl?: string;
      error?: string;
    }>;
    onMediaCommand: (callback: (cmd: string) => void) => () => void;
    proxyGet: () => Promise<ProxyConfig>;
    proxySet: (cfg: ProxyConfig) => Promise<{
      config: ProxyConfig;
      applied: { ok: boolean; applied?: string; note?: string; rules?: string; pac?: string };
    }>;
    proxyTest: () => Promise<{
      ok: boolean;
      reachable?: boolean;
      status?: number;
      message: string;
    }>;
    proxyProbeLocal: () => Promise<{
      ok: boolean;
      open?: Array<{ port: number; scheme: string; hint: string; url: string }>;
      error?: string;
    }>;
    discordGet: () => Promise<DiscordStatus>;
    discordSetConfig: (cfg: {
      enabled?: boolean;
      clientId?: string;
    }) => Promise<{
      config: { enabled: boolean; clientId: string };
      connect: { ok: boolean; error?: string; ready?: boolean; skipped?: boolean };
    }>;
    discordSetPresence: (
      payload: DiscordPresencePayload | null
    ) => Promise<{ ok: boolean; error?: string; cleared?: boolean; skipped?: boolean }>;
    discordClearPresence: () => Promise<{ ok: boolean }>;
    apiFetch: (payload: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | null;
      
      preferNet?: boolean;
      
      credentials?: 'include' | 'omit';
    }) => Promise<{ status: number; ok: boolean; body: string }>;
    apiUpload: (payload: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      fileBase64: string;
      fileName: string;
      fileField: string;
      mimeType?: string;
      fields?: Record<string, string>;
    }) => Promise<{ status: number; ok: boolean; body: string }>;
    mediaFetch: (payload: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      bodyBase64?: string | null;
    }) => Promise<{
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      bodyBase64: string;
      _via?: string;
    }>;
    
    ytFetch: (payload: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | null;
      bodyBase64?: string | null;
    }) => Promise<{
      status: number;
      ok: boolean;
      url?: string;
      headers: Record<string, string>;
      bodyBase64: string;
      _via?: string;
      _attempts?: string[];
    }>;
    
    ytResolveAudio: (videoId: string) => Promise<{
      ok: boolean;
      url?: string;
      mime?: string;
      protocol?: 'progressive' | 'hls';
      client?: string;
      error?: string;
    }>;
    
    ytPagePlay: (payload: {
      videoId: string;
      volume?: number;
      muted?: boolean;
      startAt?: number;
    }) => Promise<{
      ok: boolean;
      mode?: string;
      duration?: number;
      currentTime?: number;
      paused?: boolean;
      error?: string;
    }>;
    ytPageCommand: (payload: {
      cmd: 'play' | 'pause' | 'seek' | 'volume' | 'status' | 'stop';
      value?: number;
    }) => Promise<{
      ok: boolean;
      hasMedia?: boolean;
      paused?: boolean;
      ended?: boolean;
      currentTime?: number;
      duration?: number;
      isAd?: boolean;
      error?: string;
    }>;
    scEmbedPlay: (payload: {
      url: string;
      volume?: number;
    }) => Promise<{
      ok: boolean;
      duration?: number;
      currentTime?: number;
      error?: string;
      via?: string;
      needsClick?: boolean;
    }>;
    scEmbedCommand: (payload: {
      cmd: 'play' | 'pause' | 'seek' | 'volume' | 'status' | 'stop';
      value?: number;
    }) => Promise<{
      ok: boolean;
      hasMedia?: boolean;
      paused?: boolean;
      ended?: boolean;
      currentTime?: number;
      duration?: number;
      error?: string;
    }>;
  };
}
}

export {};
