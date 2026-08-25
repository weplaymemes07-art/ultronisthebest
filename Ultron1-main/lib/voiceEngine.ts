/**
 * VoiceEngine
 * ───────────
 * Wires up the browser's microphone + Web Speech API to:
 *   1. Measure real-time mic volume (drives the orb's "reacts to your voice" glow)
 *   2. Transcribe what you say (SpeechRecognition)
 *   3. Send the transcript to /api/chat (server route → Anthropic API)
 *   4. Speak the reply back (SpeechSynthesis) while feeding a synthetic
 *      volume envelope back to the orb so it visibly "talks" too.
 *
 * No extra npm packages required — everything here is native Web APIs.
 */

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface VoiceEngineCallbacks {
  /** 0..1 smoothed audio level — feed straight into orbScene.setAudioLevel */
  onLevel(level: number): void;
  onStatus(status: VoiceStatus): void;
  /** Live transcript while the user is talking (isFinal=false for interim text) */
  onTranscript(text: string, isFinal: boolean): void;
  /** Ultron's reply, once the AI has responded */
  onReply(text: string): void;
  onError(message: string): void;
}

// The Web Speech API's SpeechRecognition is still non-standard (webkit-prefixed
// in most browsers) so TypeScript's DOM lib doesn't reliably cover it. We only
// need a handful of members, typed loosely on purpose.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export class VoiceEngine {
  private cb: VoiceEngineCallbacks;
  private recognition: SpeechRecognitionLike | null = null;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelRaf = 0;
  private speakRaf = 0;
  private smoothedLevel = 0;
  private isSpeaking = false;
  private manuallyStopped = true;
  private history: ChatTurn[] = [];

  constructor(callbacks: VoiceEngineCallbacks) {
    this.cb = callbacks;
  }

  get speechRecognitionSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
  }

  /** Begin listening: mic level analysis + (if supported) live transcription. */
  async start(): Promise<void> {
    this.manuallyStopped = false;
    try {
      await this.startMicLevel();
    } catch {
      this.cb.onError("MICROPHONE ACCESS DENIED");
      this.manuallyStopped = true;
      throw new Error("mic-denied");
    }
    this.startRecognition();
    this.cb.onStatus("listening");
  }

  /** Stop everything: mic, recognition, and any speech in progress. */
  stop(): void {
    this.manuallyStopped = true;
    this.stopRecognitionInternal();
    this.stopMicLevel();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    cancelAnimationFrame(this.speakRaf);
    this.isSpeaking = false;
    this.cb.onLevel(0);
    this.cb.onStatus("idle");
  }

  /** Send typed text through the same AI + speech pipeline (mic optional). */
  async sendText(text: string): Promise<void> {
    return this.handleUserUtterance(text);
  }

  // ─── microphone level (drives orb reactivity while the user talks) ───

  private async startMicLevel(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.micStream = stream;
    const Ctx: typeof AudioContext =
      window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    this.audioCtx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    this.analyser = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 4.5);
      // Don't feed mic level while Ultron is talking (avoids the orb
      // reacting to its own voice bleeding into the microphone).
      if (!this.isSpeaking) {
        this.smoothedLevel += (level - this.smoothedLevel) * 0.35;
        this.cb.onLevel(this.smoothedLevel);
      }
      this.levelRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  private stopMicLevel(): void {
    cancelAnimationFrame(this.levelRaf);
    this.analyser = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.smoothedLevel = 0;
  }

  // ─── speech-to-text ───

  private startRecognition(): void {
    const SR = getSpeechRecognitionCtor();
    if (!SR) {
      this.cb.onError("SPEECH RECOGNITION NOT SUPPORTED — TYPE INSTEAD");
      return;
    }
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (final.trim()) {
        this.cb.onTranscript(final.trim(), true);
        void this.handleUserUtterance(final.trim());
      } else if (interim.trim()) {
        this.cb.onTranscript(interim.trim(), false);
      }
    };

    recognition.onerror = (event: any) => {
      if (event?.error === "not-allowed" || event?.error === "service-not-allowed") {
        this.cb.onError("MICROPHONE ACCESS DENIED");
        this.manuallyStopped = true;
      }
      // "no-speech" / "aborted" are routine (silence, restarts) — ignored.
    };

    recognition.onend = () => {
      // Browsers auto-stop recognition after a pause; restart it unless
      // we're intentionally stopped or mid-reply.
      if (!this.manuallyStopped && !this.isSpeaking) {
        try {
          recognition.start();
        } catch {
          /* already starting */
        }
      }
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      /* already started */
    }
  }

  private stopRecognitionInternal(): void {
    if (this.recognition) {
      this.recognition.onend = null;
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
      this.recognition = null;
    }
  }

  // ─── AI brain ───

  private async handleUserUtterance(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.cb.onStatus("thinking");
    // Pause recognition while we think/speak so Ultron doesn't hear itself.
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
    }

    this.history.push({ role: "user", content: trimmed });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed, history: this.history.slice(-12) }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `request failed (${res.status})`);
      }
      const reply: string = (data.reply || "").trim() || "I have nothing to report.";
      this.history.push({ role: "assistant", content: reply });
      this.cb.onReply(reply);
      this.speak(reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : "ULTRON IS OFFLINE";
      this.cb.onError(message.toUpperCase());
      this.cb.onStatus(this.manuallyStopped ? "idle" : "listening");
      if (!this.manuallyStopped && this.recognition) {
        try {
          this.recognition.start();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ─── text-to-speech, with a fake-but-convincing volume envelope ───

  private speak(text: string): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      this.cb.onStatus(this.manuallyStopped ? "idle" : "listening");
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    utter.pitch = 0.85;
    const voices = synth.getVoices();
    const preferred =
      voices.find((v) => /en/i.test(v.lang) && /daniel|male|fred|alex|arthur/i.test(v.name)) ||
      voices.find((v) => /en/i.test(v.lang));
    if (preferred) utter.voice = preferred;

    this.isSpeaking = true;
    this.cb.onStatus("speaking");

    // Word/sentence boundaries spike the level; between boundaries it decays,
    // giving the orb a natural "talking" pulse even though SpeechSynthesis
    // doesn't expose raw waveform data.
    let pulse = 0.3;
    const decayLoop = () => {
      if (!this.isSpeaking) return;
      pulse *= 0.88;
      const ambient = 0.16 + Math.abs(Math.sin(performance.now() * 0.006)) * 0.1;
      this.cb.onLevel(Math.min(1, ambient + pulse));
      this.speakRaf = requestAnimationFrame(decayLoop);
    };
    decayLoop();

    utter.onboundary = () => {
      pulse = 0.55 + Math.random() * 0.35;
    };
    const finishSpeaking = () => {
      this.isSpeaking = false;
      cancelAnimationFrame(this.speakRaf);
      this.cb.onLevel(0);
      if (!this.manuallyStopped) {
        this.cb.onStatus("listening");
        if (this.recognition) {
          try {
            this.recognition.start();
          } catch {
            /* ignore */
          }
        }
      } else {
        this.cb.onStatus("idle");
      }
    };
    utter.onend = finishSpeaking;
    utter.onerror = finishSpeaking;

    synth.speak(utter);
  }
}
