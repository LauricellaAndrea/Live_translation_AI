import { useState, useRef, useEffect } from "react";
import { 
  Mic, 
  MicOff, 
  Languages, 
  PhoneCall, 
  PhoneOff, 
  Sparkles, 
  Volume2, 
  VolumeX, 
  ShieldAlert, 
  HelpCircle, 
  History,
  Trash2,
  CheckCircle,
  Clock
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// List of supported target languages
interface Language {
  code: string;
  name: string;
  flag: string;
  localName: string;
}

const LANGUAGES: Language[] = [
  { code: "en", name: "English", flag: "🇬🇧", localName: "Inglese" },
  { code: "es", name: "Spanish", flag: "🇪🇸", localName: "Spagnolo" },
  { code: "fr", name: "French", flag: "🇫🇷", localName: "Francese" },
  { code: "de", name: "German", flag: "🇩🇪", localName: "Tedesco" },
  { code: "pt", name: "Portuguese", flag: "🇵🇹", localName: "Portoghese" },
  { code: "ru", name: "Russian", flag: "🇷🇺", localName: "Russo" },
  { code: "zh", name: "Chinese", flag: "🇨🇳", localName: "Cinese" },
  { code: "ja", name: "Japanese", flag: "🇯🇵", localName: "Giapponese" },
];

export default function App() {
  const [selectedLang, setSelectedLang] = useState<Language>(LANGUAGES[0]);
  const [isSupported, setIsSupported] = useState<boolean>(true);
  const [status, setStatus] = useState<"idle" | "connecting" | "active" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [subtitles, setSubtitles] = useState<Array<{ id: string; text: string; timestamp: Date; sender: "gemini" | "user" }>>([]);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  
  // Visualizer stats
  const [userVolume, setUserVolume] = useState<number>(0);
  const [geminiVolume, setGeminiVolume] = useState<number>(0);

  // References for WebSockets and Audio
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const subtitlesEndRef = useRef<HTMLDivElement | null>(null);

  // History log persist in localStorage
  const [savedLogs, setSavedLogs] = useState<Array<{ id: string; date: string; language: string; transCount: number }>>([]);

  useEffect(() => {
    // Check if browser supports user media
    if (!navigator.mediaDevices || !window.AudioContext) {
      setIsSupported(false);
    }

    // Load logs
    try {
      const logs = localStorage.getItem("gemini_trans_logs");
      if (logs) setSavedLogs(JSON.parse(logs));
    } catch (e) {
      console.error("Error reading from localStorage", e);
    }
  }, []);

  // Handle auto-scroll to latest subtitles
  useEffect(() => {
    subtitlesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [subtitles]);

  // Helper: Int16Array to Base64
  function int16ToBase64(int16Array: Int16Array): string {
    const buffer = int16Array.buffer;
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Helper: Base64 to PCM Float32
  function base64ToPCMFloat32(base64Str: string): Float32Array {
    try {
      const binaryStr = window.atob(base64Str);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const numSamples = len / 2;
      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }
      return float32Array;
    } catch (e) {
      console.error("Error converting Base64 to Float32 array:", e);
      return new Float32Array(0);
    }
  }

  // Playback chunks at 24kHz sequentially using AudioContext scheduling
  function playAudioChunk(audioCtx: AudioContext, base64PCM: string) {
    const float32Data = base64ToPCMFloat32(base64PCM);
    if (float32Data.length === 0) return;

    // Calculate simulated volume for visualizer
    let sumSquares = 0;
    for (let i = 0; i < float32Data.length; i++) {
      sumSquares += float32Data[i] * float32Data[i];
    }
    const rms = Math.sqrt(sumSquares / float32Data.length);
    setGeminiVolume(Math.min(100, Math.floor(rms * 450)));

    const buffer = audioCtx.createBuffer(1, float32Data.length, 24000);
    buffer.copyToChannel(float32Data, 0);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);

    const currentTime = audioCtx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      // If we lagged behind or this is the first chunk, schedule immediately with low safety buffer
      nextStartTimeRef.current = currentTime + 0.005; // 5ms safety buffer for ultra low latency
    } else if (nextStartTimeRef.current > currentTime + 0.3) {
      // Force resync if the scheduling queue has accumulated too much drift (more than 300ms)
      nextStartTimeRef.current = currentTime + 0.005;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;
  }

  // Reset visualizer volumes to 0 sequentially
  useEffect(() => {
    if (status !== "active") {
      setUserVolume(0);
      setGeminiVolume(0);
    }
  }, [status]);

  // Start Voice Support Session
  const startSession = async () => {
    if (status === "connecting" || status === "active") return;
    
    setStatus("connecting");
    setErrorMessage("");
    setSubtitles([]);
    
    try {
      // 1. Initialize Audio contexts
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      nextStartTimeRef.current = 0;

      // 2. Request user media with browser permission
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // 3. Establish WebSocket connection with server proxy
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live?lang=${selectedLang.code}&langName=${encodeURIComponent(selectedLang.localName)}&langEngName=${encodeURIComponent(selectedLang.name)}`;
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("active");
        
        // Setup mic processing nodes only once connection is established with server
        if (!inputAudioCtxRef.current || !streamRef.current) return;
        
        const source = inputAudioCtxRef.current.createMediaStreamSource(streamRef.current);
        const processor = inputAudioCtxRef.current.createScriptProcessor(1024, 1, 1);
        processorRef.current = processor;

        source.connect(processor);
        processor.connect(inputAudioCtxRef.current.destination);

        processor.onaudioprocess = (e) => {
          if (isMuted) {
            setUserVolume(0);
            return;
          }

          const channelData = e.inputBuffer.getChannelData(0);
          
          // Calculate volume level for UI visualizer
          let sumSquares = 0;
          for (let i = 0; i < channelData.length; i++) {
            sumSquares += channelData[i] * channelData[i];
          }
          const rms = Math.sqrt(sumSquares / channelData.length);
          setUserVolume(Math.min(100, Math.floor(rms * 450)));

          // Convert Float32 to standard 16-bit signed PCM
          const int16Buffer = new Int16Array(channelData.length);
          for (let i = 0; i < channelData.length; i++) {
            const s = Math.max(-1.0, Math.min(1.0, channelData[i]));
            int16Buffer[i] = s < 0 ? s * 32768 : s * 32767;
          }

          // Transform and send packet
          const base64Audio = int16ToBase64(int16Buffer);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ audio: base64Audio }));
          }
        };
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.error) {
            setErrorMessage(msg.error);
            setStatus("error");
            stopSession();
            return;
          }

          if (msg.interrupted) {
            // Cancel current speaker buffers on model turn interruption
            nextStartTimeRef.current = 0;
            setGeminiVolume(0);
          }

          if (msg.audio) {
            if (outputAudioCtxRef.current) {
              playAudioChunk(outputAudioCtxRef.current, msg.audio);
            }
          }

          if (msg.text) {
            // Append incoming translation subtitles
            setSubtitles((prev) => {
              // Throttle/merge continuous chunks from the same sender if within short sequence
              const textChunk = msg.text;
              if (prev.length > 0 && prev[prev.length - 1].sender === "gemini") {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  text: updated[updated.length - 1].text + textChunk
                };
                return updated;
              } else {
                return [
                  ...prev,
                  {
                    id: Math.random().toString(),
                    text: textChunk,
                    timestamp: new Date(),
                    sender: "gemini"
                  }
                ];
              }
            });
          }
        } catch (e) {
          console.error("Error reading WebSocket packet:", e);
        }
      };

      ws.onerror = () => {
        setErrorMessage("Impossibile connettersi al servizio di traduzione.");
        setStatus("error");
        stopSession();
      };

      ws.onclose = () => {
        if (status === "active") {
          setStatus("idle");
        }
        stopSession();
      };

    } catch (err: any) {
      console.error("Start session failure:", err);
      setErrorMessage(
        err.message?.includes("Permission denied") || err.name === "NotAllowedError"
          ? "Microfono bloccato. Consenti l'accesso al microfono nel browser per usare il servizio."
          : `Impossibile avviare il microfono: ${err.message || err}`
      );
      setStatus("error");
      stopSession();
    }
  };

  // Turn off streams and close connections clean
  const stopSession = () => {
    // Save history logs first
    if (status === "active" && subtitles.length > 0) {
      const newLog = {
        id: Math.random().toString(),
        date: new Date().toLocaleString("it-IT"),
        language: `${selectedLang.flag} ${selectedLang.name}`,
        transCount: subtitles.length
      };
      
      setSavedLogs(prev => {
        const next = [newLog, ...prev].slice(0, 5); // Keep last 5 translation sessions
        localStorage.setItem("gemini_trans_logs", JSON.stringify(next));
        return next;
      });
    }

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }

    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }

    setStatus("idle");
    setUserVolume(0);
    setGeminiVolume(0);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
    if (!isMuted) {
      setUserVolume(0);
    }
  };

  const clearHistory = () => {
    localStorage.removeItem("gemini_trans_logs");
    setSavedLogs([]);
  };

  return (
    <div className="min-h-screen bg-[#0F172A] text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-900" id="main-root">
      
      {/* Header Bar */}
      <header className="border-b border-slate-800 bg-[#1E293B]/70 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex items-center justify-between" id="header-container">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-cyan-500 to-indigo-600 p-2.5 rounded-xl shadow-lg shadow-cyan-500/10" id="app-logo-bg">
            <Sparkles className="w-6 h-6 text-white animate-pulse" id="sparkles-logo-icon" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
             Live Translation Customer Support
            </h1>
            <p className="text-xs text-slate-400">
              Servizio di traduzione istantanea e bidirezionale a bassissima latenza
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {status === "active" && (
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 font-medium"
              id="live-status-pill"
            >
              <span className="w-2.0 h-2.0 rounded-full bg-emerald-500 animate-ping" />
              LIVE CONNECTION ACTIVE
            </motion.div>
          )}
          <span className="text-xs bg-slate-800/80 border border-slate-700/50 px-3 py-1.5 rounded-full text-slate-300 font-mono flex items-center gap-1.5" id="model-id-pill">
            <Clock className="w-3.5 h-3.5" />
          live-translate-preview
          </span>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8" id="main-content-layout">
        
        {/* Left Control Column (SPAN 4) */}
        <section className="lg:col-span-4 flex flex-col gap-6" id="left-sidebar">
          
          {/* Card: Configuration */}
          <div className="bg-[#1E293B] border border-slate-800 rounded-3xl p-6 shadow-xl relative overflow-hidden" id="config-card">
            <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2" id="lang-selection-title">
              <Languages className="w-5 h-5 text-cyan-400" />
              Opzioni Traduzione
            </h2>

            <div className="space-y-5" id="config-form">
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2">
                  Lingua Sorgente (Tua lingua)
                </label>
                <div className="bg-[#0F172A] border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-300 flex items-center gap-3">
                  <span className="text-xl">🇮🇹</span>
                  <div>
                    <p className="font-semibold text-white">Italiano</p>
                    <p className="text-xs text-slate-500">Parla in Italiano al microfono</p>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2" htmlFor="target-lang-select">
                  Lingua Destinazione (Supporto)
                </label>
                <select
                  id="target-lang-select"
                  value={selectedLang.code}
                  disabled={status === "active" || status === "connecting"}
                  onChange={(e) => {
                    const found = LANGUAGES.find(l => l.code === e.target.value);
                    if (found) setSelectedLang(found);
                  }}
                  className="w-full bg-[#0F172A] hover:bg-[#16223F] text-white border border-slate-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all font-medium py-3"
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.flag} {lang.name} ({lang.localName})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-2">
                  L'audio in ingresso verrà immediatamente sintetizzato e riprodotto in questa lingua.
                </p>
              </div>

              {/* Action Button */}
              <div className="pt-2" id="action-trigger-container">
                {status === "active" ? (
                  <button
                    id="stop-assistant-btn"
                    onClick={stopSession}
                    className="w-full bg-rose-600 hover:bg-rose-500 text-white font-medium px-5 py-4 rounded-xl shadow-lg shadow-rose-950/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2.5 cursor-pointer"
                  >
                    <PhoneOff className="w-5 h-5 animate-pulse" />
                    Ferma Assistenza
                  </button>
                ) : (
                  <button
                    id="start-assistant-btn"
                    onClick={startSession}
                    disabled={status === "connecting" || !isSupported}
                    style={{
                      backgroundImage: "linear-gradient(to right, #0ea5e9, #06b6d4)",
                      color: "white"
                    }}
                    className="w-full disabled:opacity-60 text-white font-medium px-5 py-4 rounded-xl shadow-lg shadow-cyan-950/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2.5 cursor-pointer disabled:cursor-not-allowed font-semibold block"
                  >
                    {status === "connecting" ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Inizializzazione in corso...
                      </>
                    ) : (
                      <>
                        <PhoneCall className="w-5 h-5" />
                        Avvia Assistenza Vocale
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Card: Audio Visualizer Meter and Signal levels */}
          <div className="bg-[#1E293B] border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col gap-5" id="audio-levels-card">
            <h3 className="font-bold text-white text-sm uppercase tracking-wider text-slate-400" id="visualizer-headline">
              Monitoraggio Audio Real-Time
            </h3>

            {/* User Microphone input */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Mic className="w-3.5 h-3.5 text-cyan-400" />
                  Mio Input (Italiano)
                </span>
                <span className="font-mono text-slate-500">{status === 'active' && !isMuted ? `${userVolume}%` : "Spento"}</span>
              </div>
              <div className="h-2 w-full bg-[#0F172A] rounded-full overflow-hidden p-[1px]">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: status === 'active' && !isMuted ? `${userVolume}%` : '0%' }}
                  transition={{ type: "spring", stiffness: 120, damping: 15 }}
                  className="h-full bg-cyan-500 rounded-full"
                />
              </div>
            </div>

            {/* Gemini Output sound */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-indigo-400" />
                  Output AI ({selectedLang.name})
                </span>
                <span className="font-mono text-slate-500">{status === 'active' ? `${geminiVolume}%` : "Silente"}</span>
              </div>
              <div className="h-2 w-full bg-[#0F172A] rounded-full overflow-hidden p-[1px]">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: status === 'active' ? `${geminiVolume}%` : '0%' }}
                  transition={{ type: "spring", stiffness: 120, damping: 15 }}
                  className="h-full bg-indigo-500 rounded-full"
                />
              </div>
            </div>

            {/* Control controls: Mute button */}
            {status === "active" && (
              <div className="pt-2 border-t border-slate-800 flex justify-between items-center" id="voice-controls-row">
                <span className="text-xs text-slate-400">Stato Microfono</span>
                <button
                  id="mute-toggle-btn"
                  onClick={toggleMute}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                    isMuted 
                      ? "bg-rose-500/15 text-rose-400 border border-rose-500/30 hover:bg-rose-500/20" 
                      : "bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700"
                  }`}
                >
                  {isMuted ? (
                    <>
                      <MicOff className="w-3.5 h-3.5" />
                      Riprendi Audio
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5" />
                      Disattiva Mic
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Card: History Logs */}
          <div className="bg-[#1E293B] border border-slate-800 rounded-3xl p-6 shadow-xl" id="history-sidebar-card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-white text-sm uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <History className="w-4 h-4 text-slate-400" />
                Sotto-sessioni Recenti
              </h3>
              {savedLogs.length > 0 && (
                <button 
                  id="clear-history-icon-btn"
                  onClick={clearHistory} 
                  className="p-1 hover:bg-slate-800 text-slate-500 hover:text-rose-400 rounded-lg transition-all"
                  title="Cancella cronologia"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
            
            {savedLogs.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4 bg-[#0F172A]/50 rounded-xl border border-dashed border-slate-800">
                Nessuna sessione registrata.
              </p>
            ) : (
              <div className="space-y-3" id="saved-logs-list">
                {savedLogs.map((log) => (
                  <div key={log.id} className="bg-[#0F172A] border border-slate-800/80 p-3 rounded-xl flex flex-col gap-1 text-xs">
                    <div className="flex justify-between items-center text-slate-300">
                      <span className="font-semibold text-white">{log.language}</span>
                      <span className="font-mono text-[10px] text-slate-500">{log.date.split(",")[0]}</span>
                    </div>
                    <p className="text-slate-500 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                      {log.transCount} righe tradotte
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

        </section>

        {/* Right Dynamic Column (SPAN 8) */}
        <section className="lg:col-span-8 flex flex-col min-h-[500px]" id="right-workspace">
          
          {/* Subtitles Area Card */}
          <div className="bg-[#1E293B] border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col flex-1" id="subtitles-card">
            
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4" id="subs-header">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-cyan-400 animate-ping" />
                <span className="text-sm font-semibold text-white uppercase tracking-wider">
                  Trascrizione e Traduzione Simultanea
                </span>
              </div>
              <span className="text-xs text-slate-400 font-medium">
                Sottotitoli in tempo reale
              </span>
            </div>

            {/* Error notifications */}
            {errorMessage && (
              <div className="mb-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 p-4 rounded-xl flex items-start gap-3 text-sm" id="error-alert">
                <ShieldAlert className="w-5 h-5 shrink-0 text-rose-400 mt-0.5" />
                <div>
                  <p className="font-bold">Attenzione</p>
                  <p>{errorMessage}</p>
                </div>
              </div>
            )}

            {/* Subtitles stream board */}
            <div className="flex-1 overflow-y-auto max-h-[550px] p-4 bg-[#0F172A] rounded-2xl border border-slate-900 scrollbar-thin scrollbar-thumb-slate-800" id="subtitles-stream-container">
              
              {subtitles.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 gap-4" id="empty-state">
                  {status === "idle" ? (
                    <>
                      <div className="bg-[#1E293B] p-4 rounded-full border border-slate-800">
                        <Mic className="w-8 h-8 text-slate-400" />
                      </div>
                      <div>
                        <h4 className="font-bold text-white mb-1 text-base">Pronto ad iniziare il supporto</h4>
                        <p className="text-xs text-slate-400 max-w-sm">
                          Scegli la lingua di destinazione sulla sinistra e premi "Avvia Assistenza" per avviare il flusso audio bidirezionale in tempo reale.
                        </p>
                      </div>
                    </>
                  ) : status === "connecting" ? (
                    <>
                      <div className="relative">
                        <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
                      </div>
                      <div>
                        <h4 className="font-bold text-white mb-1 text-sm">Connessione in corso...</h4>
                        <p className="text-xs text-slate-500">
                          Inizializzazione dei moduli vocali ed avvio della WebSocket su Gemini Generative Service.
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Active wave simulation state */}
                      <div className="flex items-center justify-center gap-1.5 h-16" id="visualizer-wave">
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((bar) => (
                          <motion.div
                            key={bar}
                            animate={{
                              height: isMuted ? 4 : [8, 38, 8],
                            }}
                            transition={{
                              duration: 0.8,
                              repeat: Infinity,
                              repeatType: "reverse",
                              delay: bar * 0.08,
                            }}
                            className="w-1 bg-gradient-to-t from-cyan-500 to-indigo-500 rounded-full"
                          />
                        ))}
                      </div>
                      <div>
                        <h4 className="font-bold text-cyan-400 mb-1 text-sm">Assistenza Attiva. Parla ora!</h4>
                        <p className="text-xs text-slate-400 max-w-md">
                          Il sistema ascolta il microfono in Italiano e riproduce all'istante l'audio tradotto in <span className="font-semibold text-white">{selectedLang.name} ({selectedLang.localName})</span>. Qualsiasi traduzione testuale comparirà in quest'area.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Subtitles list rendering */}
              <AnimatePresence initial={false}>
                <div className="space-y-4" id="subs-list-wrapper">
                  {subtitles.map((sub) => (
                    <motion.div
                      key={sub.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className={`flex flex-col max-w-[85%] ${
                        sub.sender === "gemini" ? "mr-auto items-start" : "ml-auto items-end"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-slate-500 font-mono">
                          {sub.timestamp.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
                          sub.sender === "gemini" 
                            ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20" 
                            : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                        }`}>
                          {sub.sender === "gemini" ? `AI (${selectedLang.name})` : "Io / Italiano"}
                        </span>
                      </div>
                      
                      <div className={`p-4 rounded-2xl text-sm leading-relaxed ${
                        sub.sender === "gemini"
                          ? "bg-gradient-to-br from-[#1E293B] to-[#1E293B]/65 border border-slate-800 text-white"
                          : "bg-gradient-to-br from-[#0EA5E9]/10 to-[#0EA5E9]/5 border border-[#0EA5E9]/20 text-sky-100"
                      }`}>
                        {sub.text}
                      </div>
                    </motion.div>
                  ))}
                  <div ref={subtitlesEndRef} />
                </div>
              </AnimatePresence>

            </div>

            {/* Guidelines info banner inside workspace */}
            <div className="mt-4 bg-[#1E293B]/40 border border-slate-800/80 p-4 rounded-2xl flex items-start gap-3" id="api-banner-info">
              <HelpCircle className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
              <div className="text-xs text-slate-400 space-y-1">
                <p className="font-semibold text-slate-300">Come funziona la traduzione bidirezionale istantanea?</p>
                <p>
                  Questo modulo stabilisce una sessione di feedback a bassissima latenza con il modello <code className="text-slate-300 bg-slate-900 px-1 py-0.5 rounded">gemini-3.5-live-translate-preview</code>. L'audio captato dal microfono a 16kHz viene incapsulato e iniettato e convertito al microsecondo pronto per essere riprodotto in cuffia nella lingua scelta. Il testo sincrono viene inviato da Gemini non appena disponibile.
                </p>
              </div>
            </div>

          </div>

        </section>

      </main>

    </div>
  );
}
