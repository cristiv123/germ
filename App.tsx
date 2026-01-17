
import React, { useState, useCallback, useRef, useEffect } from 'react';
// Added Modality to imports
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';
import { fetchAllConversations, saveConversation } from './services/supabase';
import MullerAvatar from './components/FaneAvatar';
import TranscriptionView from './components/TranscriptionView';

const BASE_SYSTEM_INSTRUCTION = `Esti Herr Müller, un profesor de germana academic, calm si profesionist.
1. Saluta studentul intr-un mod politicos si cere-i numele imediat pentru a deschide dosarul academic.
2. NU incepe nicio lectie sau explicatie pana nu primesti un nume.
3. Cand primesti numele, confirma obligatoriu folosind cuvantul cheie "inregistrat" (ex: "Am inregistrat numele tau, [Nume].").
4. Dupa identificare, poarta o conversatie naturala in limba germana, adaptata nivelului studentului, axandu-te pe fluenta si corectitudine gramaticala.
5. Mai jos ai acces la ARHIVA COMPLETA a tuturor conversatiilor anterioare cu acest student. Foloseste aceste informatii pentru a continua progresul academic, a-ti aminti ce ati discutat si a personaliza lectia curenta.`;

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
      console.log("[Supabase] Se încarcă arhiva completă...");
      const history = await fetchAllConversations();
      console.log(`[Supabase] S-au găsit ${history.length} înregistrări în total.`);
      
      let contextStr = "\n--- ARHIVA COMPLETA A DOSARULUI ACADEMIC ---\n";
      history.forEach(entry => {
        contextStr += `[SESIUNE DIN DATA: ${entry.date}]\n${entry.content}\n\n`;
      });
      allHistoryContextRef.current = contextStr;
    } catch (err) {
      console.error("[Supabase] Eroare la încărcarea memoriei complete:", err);
    } finally {
      setIsLoadingMemories(false);
    }
  };

  const disconnect = useCallback(async () => {
    if (status === ConnectionStatus.IDLE && !sessionRef.current) return;

    console.log("[Audio] Deconectare resurselor...");
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
      console.error("[Gemini] API_KEY invalida.");
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
      const systemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n${allHistoryContextRef.current}`.replace(/[^\x20-\x7E\n]/g, '');

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          systemInstruction: systemInstruction,
        },
        callbacks: {
          onopen: () => {
            console.log("[Gemini] WebSocket deschis. Sesiune Muller inceputa.");
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
                console.error("[Audio] Eroare decodare lot:", err);
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
            console.error("[Gemini] Eroare Stream:", err);
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: (e) => {
            console.warn("[Gemini] Inchis de server:", e.code, e.reason);
            disconnect();
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("[Gemini] Esec la conectare:", err);
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
            <p className="text-xl text-slate-500 mb-10 max-w-2xl">Lecția de germană este gata. Profesorul Müller vă așteaptă pentru o conversație academică personalizată.</p>
            
            <button 
              onClick={connect}
              disabled={isLoadingMemories}
              className={`px-16 py-6 rounded-2xl text-xl font-bold text-white transition-all shadow-xl active:scale-95 ${isLoadingMemories ? 'bg-slate-400 cursor-not-allowed' : 'bg-blue-700 hover:bg-blue-800 shadow-blue-200'}`}
            >
              {isLoadingMemories ? 'Se încarcă arhiva...' : 'Începe Lecția'}
            </button>
            {status === ConnectionStatus.ERROR && (
              <div className="mt-8 text-red-600 font-bold bg-red-50 p-4 rounded-xl border border-red-200">
                Eroare de conexiune. Verifică microfonul și consola pentru codul 1007.
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-6 animate-in slide-in-from-bottom-4">
            <MullerAvatar isSpeaking={isSpeaking} isListening={isListening} status={status} />
            <TranscriptionView items={transcription} />
            <div className="text-center text-slate-400 italic text-sm">
              Conexiune stabilită. Profesorul ascultă...
            </div>
          </div>
        )}
      </main>
      
      {isSaving && (
        <div className="fixed bottom-6 right-6 bg-white border border-slate-200 p-4 rounded-xl text-xs font-bold academic-shadow flex items-center gap-2 animate-bounce">
          <div className="w-2 h-2 bg-green-500 rounded-full"></div>
          Sincronizare dosar academic...
        </div>
      )}
    </div>
  );
};

export default App;
