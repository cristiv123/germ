
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';
import { fetchAllConversations, saveConversation } from './services/supabase';
import MullerAvatar from './components/FaneAvatar';
import TranscriptionView from './components/TranscriptionView';

const CURRICULUM_DATA = `
PROGRAMA:
1. Gramatica: Man soll vs Man sollte, intrebari indirecte.
2. Vocabular: Academic, cariera, HR.
3. Expresii: in Erfüllung gehen, Rücksicht nehmen.
`;

const BASE_SYSTEM_INSTRUCTION = `Esti Herr Müller, profesor de germana.
1. Saluta si cere numele studentului imediat.
2. Nu preda nimic pana nu primesti un nume.
3. Cand primesti numele, confirma obligatoriu cu "inregistrat".
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
    console.log("[App] Montat.");
    syncMemories();
    return () => {
      console.log("[App] Demontat.");
      disconnect();
    };
  }, []);

  const getTimestamp = () => {
    const now = new Date();
    return `[${now.toISOString().split('T')[0]} ${now.toLocaleTimeString('ro-RO', { hour12: false })}]`;
  };

  const syncMemories = async () => {
    setIsLoadingMemories(true);
    try {
      const history = await fetchAllConversations();
      const recentHistory = history.slice(-3); // Mai restrictiv pentru a evita erori de marime
      let contextStr = "\nISTORIC RECENT:\n";
      recentHistory.forEach(entry => {
        contextStr += `${entry.date}: ${entry.content.substring(0, 500)}...\n`;
      });
      allHistoryContextRef.current = contextStr;
    } catch (err) {
      console.error("[Supabase] Eroare memorie:", err);
    } finally {
      setIsLoadingMemories(false);
    }
  };

  const disconnect = useCallback(async () => {
    if (status === ConnectionStatus.IDLE && !sessionRef.current) return;

    console.log("[Audio] Deconectare...");
    const content = fullConversationTextRef.current;
    if (content && content.length > 15) {
      setIsSaving(true);
      try {
        await saveConversation(content);
      } catch (e) {
        console.error("[Supabase] Salvare esuata:", e);
      } finally {
        setTimeout(() => setIsSaving(false), 1000);
      }
    }

    setStatus(ConnectionStatus.IDLE);
    setIsListening(false);
    setIsSpeaking(false);

    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextInRef.current && audioContextInRef.current.state !== 'closed') {
      try { await audioContextInRef.current.close(); } catch(e) {}
      audioContextInRef.current = null;
    }

    if (audioContextOutRef.current && audioContextOutRef.current.state !== 'closed') {
      try { await audioContextOutRef.current.close(); } catch(e) {}
      audioContextOutRef.current = null;
    }
    
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    activeSourcesRef.current.clear();
    
    setStudentName("Necunoscut");
    studentNameRef.current = "Necunoscut";
    fullConversationTextRef.current = "";
    setTranscription([]);
  }, [status]);

  const connect = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey || apiKey === 'undefined' || apiKey.length < 10) {
      console.error("[Gemini] API_KEY lipseste sau este invalida.");
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      setStatus(ConnectionStatus.CONNECTING);
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctxIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const ctxOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      await ctxIn.resume();
      await ctxOut.resume();
      
      audioContextInRef.current = ctxIn;
      audioContextOutRef.current = ctxOut;

      const ai = new GoogleGenAI({ apiKey });
      const systemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n${allHistoryContextRef.current}`.replace(/[^\x20-\x7E\n]/g, ''); // Curatare caractere non-ASCII simple pentru siguranta

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: ['AUDIO'], // Folosim string explicit
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          systemInstruction: systemInstruction,
          // Transcrierile sunt dezactivate temporar pentru a izola eroarea 1007
        },
        callbacks: {
          onopen: () => {
            console.log("[Gemini] Conectat.");
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
            
            const source = ctxIn.createMediaStreamSource(stream);
            const processor = ctxIn.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              const pcm = createPcmBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(s => {
                if (s) s.sendRealtimeInput({ media: pcm });
              }).catch(() => {});
            };
            source.connect(processor);
            processor.connect(ctxIn.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Logica pentru audio primis
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
              } catch (err) {
                console.error("[Audio] Eroare decodare:", err);
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
            console.error("[Gemini] Eroare:", err);
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (e) => {
            console.warn("[Gemini] Inchis:", e.code, e.reason);
            disconnect();
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("[Gemini] Esec:", err);
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
            <p className="text-slate-500 font-semibold uppercase text-[10px] tracking-widest flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500' : 'bg-slate-300'}`}></span>
              {status === ConnectionStatus.CONNECTED ? `Sesiune: ${studentName}` : 'Cabinet Academic'}
            </p>
          </div>
        </div>

        {status === ConnectionStatus.CONNECTED && (
          <button 
            onClick={disconnect}
            className="bg-red-50 text-red-600 hover:bg-red-600 hover:text-white px-6 py-2 rounded-xl font-bold transition-all border border-red-100 active:scale-95"
          >
            Ieșire
          </button>
        )}
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto flex flex-col">
        {status === ConnectionStatus.IDLE || status === ConnectionStatus.ERROR ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 animate-in fade-in duration-700">
            <h2 className="text-5xl font-bold text-slate-900 mb-6">Willkommen!</h2>
            <p className="text-xl text-slate-500 mb-10 max-w-2xl">Lecția de germană este gata. Profesorul Müller vă așteaptă pentru a începe conversația.</p>
            
            <button 
              onClick={connect}
              disabled={isLoadingMemories}
              className={`px-16 py-6 rounded-2xl text-xl font-bold text-white transition-all shadow-xl active:scale-95 ${isLoadingMemories ? 'bg-slate-400 cursor-not-allowed' : 'bg-blue-700 hover:bg-blue-800 shadow-blue-200'}`}
            >
              {isLoadingMemories ? 'Se încarcă...' : 'Începe Lecția'}
            </button>
            {status === ConnectionStatus.ERROR && (
              <div className="mt-8 text-red-600 font-bold bg-red-50 p-4 rounded-xl border border-red-200">
                Eroare de conexiune. Te rugăm să verifici microfonul și să reîncerci.
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-6 animate-in slide-in-from-bottom-4">
            <MullerAvatar isSpeaking={isSpeaking} isListening={isListening} status={status} />
            <TranscriptionView items={transcription} />
            <div className="text-center text-slate-400 italic text-sm">
              Sesiune audio activă...
            </div>
          </div>
        )}
      </main>
      
      {isSaving && (
        <div className="fixed bottom-6 right-6 bg-white border border-slate-200 p-4 rounded-xl text-xs font-bold academic-shadow flex items-center gap-2 animate-bounce">
          <div className="w-2 h-2 bg-green-500 rounded-full"></div>
          Se salvează...
        </div>
      )}
    </div>
  );
};

export default App;
