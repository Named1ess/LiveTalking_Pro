# LiveTalking Desktop

Electron + React + TypeScript desktop client for the existing LiveTalking Python server.

## Development

Start the Python backend first:

```powershell
python app.py --transport webrtc --model wav2lip --avatar_id wav2lip256_avatar1
```

Then run the desktop client:

```powershell
cd desktop
npm install
npm run dev
```

The app defaults to `http://127.0.0.1:8010`.

## Build

```powershell
cd desktop
npm run build
npm run dist
```

The Windows installer is written to `desktop/release/`.

## MVP scope

- Configure backend address.
- Connect to `/offer` and play WebRTC audio/video.
- Send text to `/human`.
- Capture microphone audio, stream 16 kHz PCM16 to `/api/asr`, display the final text, and optionally forward it to `/human`.
- Package with `electron-builder`.
