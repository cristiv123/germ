
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';
import { fetchAllConversations, saveConversation } from './services/supabase';
import MullerAvatar from './components/FaneAvatar';
import TranscriptionView from './components/TranscriptionView';

const CURRICULUM_DATA = `
DATE DE INITIALIZARE (PROGRAMA):
1. Gramatică: Diferența "Man soll" vs "Man sollte", întrebări indirecte, conectori temporali.
2. Vocabular B2.2: Context academic, carieră, HR, prietenie și stima de sine.
3. Expresii Fixe (NVV): in Erfüllung gehen, Rücksicht nehmen, einen Entschluss fassen.
`;

const BASE_SYSTEM_INSTRUCTION = `Ești Herr Müller, profesor de germană academic.

### PROTOCOLUL DE IDENTIFICARE (CRITIC) ###
1. **Sarcina Ta Imediată**: Imediat ce începe sesiunea, salută și cere numele studentului. 
2. **Blocaj**: NU preda nimic până nu ai primit un nume.
3. **Confirmarea Înregistrării**: Când studentul își spune numele, confirmă obligatoriu folosind cuvântul cheie "înregistrat".

${CURRICULUM_DATA}`;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingMemories, setIsLoadingMemories] = useState(true);
  const [transcription, setTranscription] = useState<TranscriptionPart[]>([]);
  const [studentName, setStudentName] = useState<string>("Necunoscut");
  
  const studentNameRef = useRef<string>("Necunoscut");
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionBufferRef = useRef({ user: '', model: '' });
  
  const fullConversationTextRef = useRef<string>("");
  const allHistoryContextRef = useRef<string>("");

  useEffect(() => {
    console.log("[App] Componenta s-a montat.");
    syncMemories();
    return () => console.log("[App] Componenta se va demonta.");
  }, []);

  const getTimestamp = () => {
    const now = new Date();
    return `[${now.toISOString().split('T')[0]} ${now.toLocaleTimeString('ro-RO', { hour12: false })}]`;
  };

  const syncMemories = async () => {
    console.log("[Supabase] Sincronizare memorii...");
    setIsLoadingMemories(true);
    try {
      const history = await fetchAllConversations();
      console.log(`[Supabase] S-au găsit ${history.length} sesiuni anterioare.`);
      const recentHistory = history.slice(-5);
      let contextStr = "\n\n### ARHIVA ACADEMICĂ (Istoric Recent) ###\n";
      recentHistory.forEach(entry => {
        contextStr += `--- SESIUNE ${entry.date} ---\n${entry.content}\n\n`;
      });
      allHistoryContextRef.current = contextStr;
    } catch (err) {
      console.error("[Supabase] Eroare la încărcarea memoriei:", err);
    } finally {
      setIsLoadingMemories(false);
    }
  };

  const disconnect = useCallback(async () => {
    // Evităm execuția multiplă dacă suntem deja IDLE
    if (status === ConnectionStatus.IDLE && !sessionRef.current && !audioContextInRef.current) return;

    console.log("[Audio] Deconectare și curățare resurse...");
    const content = fullConversationTextRef.current;
    if (content && content.length > 15) {
      setIsSaving(true);
      console.log("[Supabase] Salvare finală conversație...");
      try {
        await saveConversation(content);
        console.log("[Supabase] Salvare finalizată cu succes.");
      } catch (e) {
        console.error("[Supabase] Salvare eșuată la deconectare:", e);
      } finally {
        setTimeout(() => setIsSaving(false), 2000);
      }
    }

    // Resetăm starea UI imediat pentru a preveni interacțiuni duble
    setStatus(ConnectionStatus.IDLE);
    setIsListening(false);
    setIsSpeaking(false);

    if (sessionRef.current) {
      console.log("[Gemini] Închidere sesiune active.");
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }

    if (streamRef.current) {
      console.log("[Audio] Oprire stream microfon.");
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Închidere AudioContext In cu verificare de stare
    if (audioContextInRef.current) {
      if (audioContextInRef.current.state !== 'closed') {
        console.log("[Audio] Închidere AudioContext In.");
        audioContextInRef.current.close().catch(e => console.debug("AudioContext In close suppressed:", e));
      }
      audioContextInRef.current = null;
    }

    // Închidere AudioContext Out cu verificare de stare
    if (audioContextOutRef.current) {
      if (audioContextOutRef.current.state !== 'closed') {
        console.log("[Audio] Închidere AudioContext Out.");
        audioContextOutRef.current.close().catch(e => console.debug("AudioContext Out close suppressed:", e));
      }
      audioContextOutRef.current = null;
    }
    
    activeSourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    activeSourcesRef.current.clear();
    
    setStudentName("Necunoscut");
    studentNameRef.current = "Necunoscut";
    fullConversationTextRef.current = "";
    setTranscription([]);
  }, [status]);

  const connect = async () => {
    console.log("[Gemini] Inițiere procedură conectare...");
    if (!process.env.API_KEY) {
      console.error("[Gemini] API_KEY lipsește. Verifică variabilele de mediu.");
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      setStatus(ConnectionStatus.CONNECTING);
      
      console.log("[Audio] Cerere permisiune microfon...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[Audio] Microfon accesat.");
      streamRef.current = stream;

      const ctxIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const ctxOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      await ctxIn.resume();
      await ctxOut.resume();
      console.log("[Audio] AudioContext-uri pregătite. In:", ctxIn.state, "Out:", ctxOut.state);
      
      audioContextInRef.current = ctxIn;
      audioContextOutRef.current = ctxOut;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const systemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n${allHistoryContextRef.current}`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          systemInstruction: systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("[Gemini] WebSocket deschis.");
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
            
            const source = ctxIn.createMediaStreamSource(stream);
            const processor = ctxIn.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              if (sessionRef.current) {
                const pcm = createPcmBlob(e.inputBuffer.getChannelData(0));
                sessionRef.current.sendRealtimeInput({ media: pcm });
              }
            };
            source.connect(processor);
            processor.connect(ctxIn.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.inputTranscription) transcriptionBufferRef.current.user += msg.serverContent.inputTranscription.text;
            if (msg.serverContent?.outputTranscription) transcriptionBufferRef.current.model += msg.serverContent.outputTranscription.text;
            
            if (msg.serverContent?.turnComplete) {
              const u = transcriptionBufferRef.current.user.trim();
              const m = transcriptionBufferRef.current.model.trim();
              const ts = getTimestamp();

              if (studentNameRef.current === "Necunoscut" && m.toLowerCase().includes("înregistrat")) {
                const parts = m.split(/înregistrat,?\s*/i);
                if (parts.length > 1) {
                  const detected = parts[1].split(/[.!?\s,]/)[0].trim();
                  if (detected) {
                    studentNameRef.current = detected;
                    setStudentName(detected);
                    fullConversationTextRef.current = fullConversationTextRef.current.replace(/\[Necunoscut\]/g, `[${detected}]`);
                  }
                }
              }

              const nameToLog = studentNameRef.current;
              if (u) {
                fullConversationTextRef.current += `${ts} [${nameToLog}] Student: ${u}\n`;
                setTranscription(prev => [...prev, { text: u, isUser: true, timestamp: Date.now() }]);
              }
              if (m) {
                fullConversationTextRef.current += `${ts} [${nameToLog}] Prof. Müller: ${m}\n`;
                setTranscription(prev => [...prev, { text: m, isUser: false, timestamp: Date.now() }]);
              }
              transcriptionBufferRef.current = { user: '', model: '' };
            }

            const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              if (ctx.state === 'suspended') await ctx.resume();

              setIsSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              try {
                const buffer = await decodeAudioData(decode(audio), ctx, 24000, 1);
                const sourceNode = ctx.createBufferSource();
                sourceNode.buffer = buffer;
                sourceNode.connect(ctx.destination);
                sourceNode.onended = () => {
                  activeSourcesRef.current.delete(sourceNode);
                  if (activeSourcesRef.current.size === 0) setIsSpeaking(false);
                };
                sourceNode.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buffer.duration;
                activeSourcesRef.current.add(sourceNode);
              } catch (decodeErr) {
                console.error("[Audio] Eroare decodare:", decodeErr);
              }
            }

            if (msg.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }
          },
          onerror: (err) => {
            console.error("[Gemini] Eroare critică:", err);
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (e) => {
            console.warn("[Gemini] Sesiune închisă.", e.code, e.reason);
            disconnect();
          }
        }
      });
      sessionRef.current = await sessionPromise;
      console.log("[Gemini] Sesiune stabilită.");
    } catch (err) {
      console.error("[Gemini] Conexiune eșuată:", err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-100 p-4 md:p-8 text-slate-900">
      <header className="w-full max-w-5xl mx-auto flex justify-between items-center mb-8 bg-white p-6 rounded-3xl academic-shadow">
        <div className="flex items-center gap-5">
          <div className="w-16 h-16 bg-blue-700 rounded-2xl flex items-center justify-center shadow-lg">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Prof. <span className="text-blue-700">Müller</span></h1>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`}></span>
              <p className="text-slate-500 font-semibold uppercase text-[10px] tracking-widest">
                {status === ConnectionStatus.CONNECTED ? `Sesiune activă: ${studentName}` : 'Academia de Limbi'}
              </p>
            </div>
          </div>
        </div>

        {status === ConnectionStatus.CONNECTED && (
          <button 
            onClick={disconnect}
            className="bg-red-50 text-red-600 hover:bg-red-600 hover:text-white px-8 py-3 rounded-2xl font-bold transition-all border border-red-100 academic-shadow flex items-center gap-3 active:scale-95"
          >
            <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
            Termină Lecția
          </button>
        )}
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto flex flex-col">
        {status === ConnectionStatus.IDLE || status === ConnectionStatus.ERROR ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 animate-in fade-in duration-1000">
            <div className="mb-6 p-4 bg-blue-50 rounded-full inline-block">
              <span className="text-blue-700 font-bold text-lg px-6 py-2 italic uppercase tracking-wider">Protocol de Identificare Academică</span>
            </div>
            <h2 className="text-5xl md:text-7xl font-bold text-slate-900 mb-6 tracking-tight leading-tight">
              Să începem <br/><span className="text-blue-700">noua lecție.</span>
            </h2>
            <p className="text-xl text-slate-500 mb-10 max-w-2xl font-medium">Pregătiți-vă pentru o sesiune interactivă. Profesorul vă va solicita numele pentru a sincroniza dosarul dumneavoastră.</p>
            
            <button 
              onClick={connect}
              disabled={isLoadingMemories}
              className={`group relative overflow-hidden px-20 py-8 rounded-3xl transition-all academic-shadow active:scale-95 ${isLoadingMemories ? 'bg-slate-200 cursor-wait' : 'bg-blue-700 hover:bg-blue-800 shadow-blue-200 shadow-2xl'}`}
            >
              <span className="relative z-10 text-2xl font-bold text-white uppercase tracking-wide">
                {isLoadingMemories ? 'Se încarcă istoricul...' : 'Intră în Cabinet'}
              </span>
            </button>
            {status === ConnectionStatus.ERROR && (
              <div className="mt-8 p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 font-bold max-w-md">
                <p>Eroare de conexiune (1007: Argument invalid sau rețea).</p>
                <p className="text-sm font-normal mt-1 opacity-80 italic">Verifică permisiunile microfonului și consola (F12) pentru detalii.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-6 animate-in slide-in-from-bottom-4 duration-500">
            <MullerAvatar isSpeaking={isSpeaking} isListening={isListening} status={status} />
            <TranscriptionView items={transcription} />
            <div className="flex justify-center pb-6">
              <div className="bg-white px-10 py-5 rounded-full flex items-center gap-4 academic-shadow border border-slate-100">
                <div className={`w-3 h-3 rounded-full ${isListening ? 'bg-blue-600 animate-ping' : 'bg-slate-300'}`}></div>
                <span className="text-slate-600 font-bold text-lg italic tracking-tight">
                  {studentName === 'Necunoscut' ? 'Așteptăm identificarea numelui...' : 'Sesiunea Müller este securizată.'}
                </span>
              </div>
            </div>
          </div>
        )}
      </main>
      
      {isSaving && (
        <div className="fixed bottom-10 right-10 bg-white border border-slate-200 text-slate-800 px-8 py-4 rounded-2xl text-sm font-bold flex items-center gap-4 academic-shadow animate-in slide-in-from-right-10 z-50">
          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
          Sincronizare dosar [{studentName}]...
        </div>
      )}
    </div>
  );
};

export default App;
