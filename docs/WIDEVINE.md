# Optional: Widevine (not the default GitHub path)

miura **by default** uses **stock Electron** and only plays **open** progressive/HLS streams.  
That is the path that is safe to publish on GitHub.

## Why DRM is not the default

Modern SoundCloud tracks often only offer **encrypted HLS** (Widevine / PlayReady / FairPlay).  
Playing them requires Google’s **Widevine CDM**, usually via:

- [Castlabs Electron for Content Security](https://github.com/castlabs/electron-releases)  
- Production **EVS** signing if you ship binaries  

Castlabs + EVS is fine for **private** experiments. It is a poor fit as the **required** install path for an open MIT repo:

- Extra paid/process steps for every contributor  
- License / compliance burden for Widevine  
- Clones fail or half-work without CDM  

## If you still want to experiment privately

1. Replace `electron` in `package.json` with a Castlabs tag, e.g.  
   `"electron": "https://github.com/castlabs/electron-releases#v34.5.8+wvcus"`  
2. Re-add Shaka Player DRM wiring (see git history if removed).  
3. Call `components.whenReady()` before creating the window.  
4. For public releases, use [Castlabs EVS](https://github.com/castlabs/electron-releases/wiki/EVS).

## Recommended product stance for open source

- Play everything that has **clear** media  
- Label DRM-only tracks in the UI  
- Do not open browser/widgets automatically  
- Document the limit honestly (this file + README)  

That is the approach miura uses for GitHub.
