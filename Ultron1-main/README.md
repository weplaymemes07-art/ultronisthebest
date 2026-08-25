# ULTRON Orb UI

An Iron Man–inspired holographic orb built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking — control it with your bare hands through your webcam.

> 🔮 This is the open-source **interface** of [ULTRON](https://sagartamang.com/projects/ultron) — my AI that talks in real time and controls Android devices by itself. **[Read the write-up](https://sagartamang.com/projects/ultron)** or **[the X post](https://x.com/sagar_builds/status/2077277583646101921)**

> 📱 **[Watch the demo on Instagram](https://www.instagram.com/p/DayJ17OTwvx/)**

![ULTRON orb UI](docs/screenshot.png)

https://github.com/user-attachments/assets/91578a83-9a27-44e8-84b0-96defcfd7366

## Getting started

```bash
npm install
cp .env.example .env.local   # then paste your GEMINI_API_KEY
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Deploying to Vercel: add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) as
an Environment Variable in the project settings, then redeploy. Without it, voice
chat will show "Server is missing GEMINI_API_KEY" but the orb and hand gestures
still work fine.

## Controls

### Mouse / touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll / pinch | Zoom in & out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access, then:

| Gesture | Action |
| --- | --- |
| Pinch (thumb + index) one hand and move it | Spin the orb |
| Pinch with **both** hands, spread apart / bring together | Zoom in / out |

### Voice (talk to Ultron)

Click **TALK** (or press `V`) and allow microphone access. Speak naturally —
Ultron transcribes it, thinks, replies out loud, and keeps listening for your
next line. No mic, or a browser without speech recognition (e.g. Firefox)?
Type into the box at the top instead — same AI, same spoken reply.

The orb glows, pulses, and spins faster in sync with the audio level — both
while you're talking into the mic and while Ultron is speaking back.

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `V` | Toggle voice mode |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |

## How it works

- **`lib/orbScene.ts`** — the Three.js scene: layered wireframe shells, a spiral
  inner core, floating code-text sprites, orbiting debris, dust particles, scan
  rings, and a bloom + chromatic-aberration post-processing stack. Exposes
  `setAudioLevel()` so an external 0–1 level can drive the glow/pulse/bloom.
- **`lib/handTracker.ts`** — MediaPipe HandLandmarker running on the webcam
  feed. Pinch detection with hysteresis: one pinched hand spins the orb, two
  pinched hands zoom by spreading apart or together.
- **`lib/voiceEngine.ts`** — microphone volume analysis (Web Audio API),
  speech-to-text (Web Speech API `SpeechRecognition`), and text-to-speech
  (`SpeechSynthesis`) with a synthetic volume envelope so the orb visibly
  "talks" even though `SpeechSynthesis` doesn't expose raw audio.
- **`app/api/chat/route.ts`** — server route that forwards your message to the
  Gemini API using `GEMINI_API_KEY` and returns Ultron's reply. This key
  never reaches the browser.
- **`components/JarvisOrb.tsx`** — the HUD and glue between the scene, the
  tracker, the voice engine, and your inputs.

## License

MIT
