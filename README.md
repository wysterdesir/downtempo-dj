# Lowtide

A personal downtempo listening room built for **wysterdesir**. Static HTML, CSS and JavaScript; no runtime packages, server, or subscription required for the player. Google Drive authorization is optional and needs the one-time setup below.

## Listen

1. Open the website, choose **Open music folder** or **Choose audio files**, and select your music. A folder available through Google Drive for desktop works too. Folder contents are read locally, including nested folders. The app never uploads selected audio.
2. Press the round master play button. Space pauses/resumes the whole session. Browsers require that first play gesture.
3. Leave Automix on for continuous playback. Choose a **Warm blend** with a gradual bass handoff or a **Clean** equal-power fade. The length slider requests 4–48 seconds; short tracks shorten the overlap automatically.
4. The row play button brings a track in with a short transition. A/B buttons start a manual deck and turn off automix. The master button pauses both decks; individual deck play buttons pause/resume the session or bring in a prepared track. Waveform clicks and Cue restart the selected track as the current session deck.
5. **Try a soundcheck** plays three original synthesized 38-second clips. They are explicitly test audio, not the user's recordings. This lets you try the controls without providing files or Google credentials.
6. **Shuffle** visibly rearranges Collection into the new play order and updates Up next, including tracks that were preloaded. The current track, a blend already playing, and a transition starting within a quarter-second stay in place. Turning Shuffle off restores the original collection order after the current mix. Each toggle rebuilds the upcoming collection, so previously played tracks can appear again.

Your library is held in memory. Local files must be selected again after a reload; browser security prevents silently reopening them. Preferences and the non-secret Google client ID/folder URL are stored on this device. Google access tokens are only held in memory.

## Automix design

- Full audio decoding before a source is scheduled. Up to three voices (current plus two ahead), bounded decoded-buffer caching, and node cleanup after completion.
- Playback starts and 1,024-point gain curves run on the **Web Audio clock**. Animation frames only draw UI; they do not drive audio transitions.
- Equal-power sine/cosine gains use a smoothstep phase to avoid sudden envelope slope changes. Warm mode reduces the outgoing low end while bringing in the incoming bass.
- Conservative RMS level matching, capped gain boost and peak headroom, plus a master dynamics compressor. This is not a LUFS-certified loudness normalizer or a true-peak brickwall limiter.
- Silence detection trims near-silent track edges. Off-main-thread analysis fits separate intro and outro beat grids to low-frequency transients at roughly 5 ms resolution. The fitter retains fractional BPM, measures grid coverage and timing residuals, and rejects unreliable or irregular grids.
- **Beat sync is on by default.** For confident grids, the incoming source matches the actual outgoing tempo, including any existing rate adjustment. Every beat in the overlap shares the same audio-clock position. The overlap covers a multiple of four beats and ends on a detected outgoing beat. A short pre-roll preserves the incoming attack. Play-next quantizes to the next beat when the current region has a reliable grid.
- Speed changes are limited to **±6%** using native AudioBuffer playback rate. This is vinyl-style matching: **pitch changes with speed**, and the matched speed stays constant for the track to prevent drift during the blend. There is no pitch lock, key detection, downbeat/phrase recognition, or stem separation. Disable Sync beats during automix in Settings for original-speed future tracks.
- A visible BEAT MATCHED status confirms a scheduled sync. When analysis is uncertain, tempo differences exceed the limit, the steady region is too short, or loading finishes too late, the player shows the reason and uses a shorter crossfade (about eight seconds or less) to limit clashing rhythms. Automatic grids remain estimates; precise scheduling does not guarantee correct beat interpretation for every recording.
- Failed downloads/decodes are skipped while existing audio keeps playing. A late network response shortens the fade where possible. An exhausted prepared queue, expired Drive sign-in, a sleeping device, or browser audio suspension can still interrupt playback. Keep the device awake; optional Screen Wake Lock is used where available.
- Repeat switches affect tracks that have not yet been prepared. Already scheduled tracks finish. Fade/style changes replan unstarted tracks; a transition already in progress completes.

## Connect private Google Drive

The original folder is already filled in under **Settings → Google Drive**:

`https://drive.google.com/drive/folders/1qs5Vu0puq2Fw1tlwd9mxA8lt34QgRvgw`

The Codex Drive connector does not give this independent website a Google sign-in. Never embed its credentials or a personal bearer token in the repository.

1. In [Google Cloud](https://console.cloud.google.com/), select or create your project and enable the **Google Drive API**.
2. Configure the OAuth consent screen. For a personal external app in Testing, add your Google account as a test user.
3. Create an **OAuth client ID → Web application**. Add the exact authorized JavaScript origins: `http://127.0.0.1:4173` for local use and `https://wysterdesir.github.io` for GitHub Pages. Origins contain no repository path.
4. Copy its **client ID**, ending in `.apps.googleusercontent.com`, into Lowtide's settings. Do not enter a client secret. This app uses Google's browser token model and requests `drive.readonly`; Google's consent covers Drive read access, while the app limits its own listing to the chosen folder and its subfolders.
5. Click **Sign in & load folder**. If Google blocks the popup on the first attempt, click again after its sign-in script loads. Google may require verification for broader public use of restricted Drive scopes. Personal testing remains subject to Google account and project policies.

Downloads use authenticated `files/{id}?alt=media`, not public share links. Folder listing handles pagination, nested folders, supported audio types, and download permissions. Tokens are not stored, logged, sent to GitHub, or placed in URL parameters. Reconnect when authorization expires. Disconnect revokes the in-memory token.

## Run locally

With Node.js 22 or later:

```sh
npm start
```

Open the URL printed by the server. No dependency installation is needed. Opening `index.html` as a `file://` URL will not work reliably because it uses JavaScript modules and a module worker.

## GitHub Pages

The source is ready for `wysterdesir/downtempo-dj`. Only the app source is published; `.gitignore` excludes common audio formats and local environment files.

1. Create the repository under `wysterdesir`, commit these files on `main`, and push.
2. In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. The included workflow checks JavaScript syntax, runs the tests, and publishes `dist/`. Relative asset paths work below a repository URL.

GitHub Pages access depends on the account plan and repository settings. A public site does not make your Drive audio public: each browser still needs Google authorization or a local file selection. A private repository alone does not guarantee a private Pages website.

## Verification

```sh
npm run check
npm test
```

The automated suite checks equal-power envelopes, two-tone RMS continuity, fractional BPM/phase recovery with offbeat percussion, per-beat alignment across 32-second overlaps, chained tempo adjustments, rate-aware positions, sync cancellation, fallback cases, shuffle visibility, queue safety, Drive pagination and expiry. Independently synthesized kick patterns at different tempos align within 15 ms after analysis; ideal-grid scheduling tests align within one 48 kHz sample. These are synthetic test results, not measured accuracy on the user's music library. Engine scheduling tests use an injected audio-clock model; they are not a substitute for listening tests on target browsers or an end-to-end OAuth test with your Google project.

Optional WebMCP controls expose `get_listening_session` and `configure_automix` if the browser supports `document.modelContext`. They share the same app state as the controls and never initiate playback or sign-in. Their registration, valid configuration and invalid-input rejection were checked in the local preview.

## References

- [Google Identity Services token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Web Audio scheduled source starts](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)
- [Native playback rate and resampling](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/playbackRate)

Beatport DJ was consulted as a functional reference for two decks, transport controls, waveforms, and its library/Automix layout. No Beatport source, artwork, audio, or account credentials are bundled.
