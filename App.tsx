
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

const BASE_SYSTEM_INSTRUCTION = `Ești Herr Müller, profesor de germană.

### PROTOCOLUL DE START (STRICT) ###
1. **Salutul**: "Guten Tag! Ich bin Herr Müller, Ihr Deutschlehrer."
2. **Identificarea**: Cere studentului numele. Spune-i clar: "Îmi puteți spune numele dumneavoastră pentru a vă înregistra în sistem?"
3. **Așteptarea**: NU preda nimic, NU face propuneri și NU trece la subiecte de studiu până când studentul nu își spune numele. Dacă studentul încearcă să schimbe subiectul, revino politicos: "Mai întâi, aș dori să vă cunosc numele."
4. **Confirmarea**: Odată ce ai numele, confirmă-l clar: "V-am înregistrat, [Nume]. Acum, ce doriți să studiem astăzi?"

### FORMAT LOGARE ###
Voi salva datele în formatul: [DATA ORA:MINUT:SECUNDĂ] [NUME STUDENT] Rol: Mesaj.

${CURRICULUM_DATA}`;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingMemories, setIsLoadingMemories] = useState(true);
  const [transcription, setTranscription] = useState<TranscriptionPart[]>([]);
  const [studentName, setStudentName] = useState<string>("Necunoscut");
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionBufferRef = useRef({ user: '', model: '' });
  
  const fullConversationTextRef = useRef<string>("");
  const allHistoryContextRef = useRef<string>("");

  const getTimestamp = () => {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0]; // HH:mm:ss
    return `[${date} ${time}]`;
  };

  const syncMemories = async () => {
    setIsLoadingMemories(true);
    try {
      const history = await fetchAllConversations();
      let contextStr = "\n\n### ARHIVA ACADEMICĂ ###\n";
      history.forEach(entry => {
        contextStr += `--- SESIUNE ${entry.date} ---\n${entry.content}\n\n`;
      });
      allHistoryContextRef.current = contextStr;
    } catch (err) {
      console.error("Eroare memorie:", err);
    } finally {
      setIsLoadingMemories(false);
    }
  };

  useEffect(() => { syncMemories(); }, []);

  // Salvare automată la fiecare 15 secunde dacă există conținut nou
  useEffect(() => {
    let lastSaved = "";
    const timer = setInterval(async () => {
      const current = fullConversationTextRef.current;
      if (current && current !== lastSaved) {
        setIsSaving(true);
        try {
          await saveConversation(current);
          lastSaved = current;
        } finally {
          setTimeout(() => setIsSaving(false), 1500);
        }
      }
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextInRef.current) audioContextInRef.current.close();
    if (audioContextOutRef.current) audioContextOutRef.current.close();
    
    activeSourcesRef.current.forEach(s => s.stop());
    activeSourcesRef.current.clear();
    
    setStatus(ConnectionStatus.IDLE);
    setIsListening(false);
    setIsSpeaking(false);
    setStudentName("Necunoscut");
  }, []);

  const connect = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          systemInstruction: `${BASE_SYSTEM_INSTRUCTION}\n${allHistoryContextRef.current}`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
            sessionPromise.then(s => s.sendRealtimeInput({ media: { data: "", mimeType: 'audio/pcm;rate=16000' } }));

            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            const processor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const pcm = createPcmBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcm }));
            };
            source.connect(processor);
            processor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.inputTranscription) transcriptionBufferRef.current.user += msg.serverContent.inputTranscription.text;
            if (msg.serverContent?.outputTranscription) transcriptionBufferRef.current.model += msg.serverContent.outputTranscription.text;
            
            if (msg.serverContent?.turnComplete) {
              const u = transcriptionBufferRef.current.user.trim();
              const m = transcriptionBufferRef.current.model.trim();
              const ts = getTimestamp();

              // Heuristică simplă: dacă studentul se prezintă, încercăm să extragem numele din confirmarea AI-ului
              if (studentName === "Necunoscut" && m.includes("v-am înregistrat")) {
                 const match = m.match(/înregistrat,?\s*([^.!?]+)/i);
                 if (match) setStudentName(match[1].trim());
              }

              if (u) {
                fullConversationTextRef.current += `${ts} [${studentName}] Student: ${u}\n`;
                setTranscription(prev => [...prev, { text: u, isUser: true, timestamp: Date.now() }]);
              }
              if (m) {
                fullConversationTextRef.current += `${ts} [${studentName}] Prof. Müller: ${m}\n`;
                setTranscription(prev => [...prev, { text: m, isUser: false, timestamp: Date.now() }]);
              }
              transcriptionBufferRef.current = { user: '', model: '' };
            }

            const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio && audioContextOutRef.current) {
              setIsSpeaking(true);
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                activeSourcesRef.current.delete(source);
                if (activeSourcesRef.current.size === 0) setIsSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSourcesRef.current.add(source);
            }
          },
          onerror: () => setStatus(ConnectionStatus.ERROR),
          onclose: () => disconnect()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
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
                {status === ConnectionStatus.CONNECTED ? `Student: ${studentName}` : 'Academia de Limbă'}
              </p>
            </div>
          </div>
        </div>

        {status === ConnectionStatus.CONNECTED && (
          <button 
            onClick={disconnect}
            className="bg-red-50 text-red-600 hover:bg-red-600 hover:text-white px-6 py-3 rounded-2xl font-bold transition-all border border-red-100 academic-shadow flex items-center gap-3"
          >
            <div className="w-2 h-2 bg-red-500 rounded-full"></div>
            Termină Lecția
          </button>
        )}
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto flex flex-col">
        {status === ConnectionStatus.IDLE || status === ConnectionStatus.ERROR ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 animate-in fade-in duration-700">
            <div className="mb-6 p-4 bg-blue-50 rounded-full inline-block">
              <span className="text-blue-700 font-bold text-lg px-6 py-2 italic uppercase tracking-wider">Identificare Obligatorie</span>
            </div>
            <h2 className="text-5xl md:text-7xl font-bold text-slate-900 mb-6 tracking-tight leading-tight">
              Suntem gata să <br/><span className="text-blue-700">vă înregistrăm?</span>
            </h2>
            <p className="text-xl text-slate-500 mb-10 max-w-2xl font-medium">Lecția va începe imediat ce Herr Müller vă va afla numele. Toate progresele vor fi salvate cronologic în dosarul dumneavoastră.</p>
            
            <button 
              onClick={connect}
              disabled={isLoadingMemories}
              className={`group relative overflow-hidden px-20 py-8 rounded-3xl transition-all academic-shadow active:scale-95 ${isLoadingMemories ? 'bg-slate-200' : 'bg-blue-700 hover:bg-blue-800'}`}
            >
              <span className="relative z-10 text-2xl font-bold text-white uppercase tracking-wide">
                {isLoadingMemories ? 'Accesăm Arhiva...' : 'Începe Identificarea'}
              </span>
            </button>
            {status === ConnectionStatus.ERROR && <p className="mt-6 text-red-500 font-bold">A apărut o eroare. Reîncercați conexiunea.</p>}
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-6 animate-in slide-in-from-bottom-4 duration-500">
            <MullerAvatar isSpeaking={isSpeaking} isListening={isListening} status={status} />
            <TranscriptionView items={transcription} />
            <div className="flex justify-center pb-6">
              <div className="bg-white px-10 py-5 rounded-full flex items-center gap-4 academic-shadow border border-slate-100">
                <div className="w-3 h-3 bg-blue-600 rounded-full animate-ping"></div>
                <span className="text-slate-600 font-bold text-lg italic tracking-tight">Vă rugăm să vă spuneți numele...</span>
              </div>
            </div>
          </div>
        )}
      </main>
      
      {isSaving && (
        <div className="fixed bottom-10 right-10 bg-white border border-slate-200 text-slate-800 px-8 py-4 rounded-2xl text-sm font-bold flex items-center gap-4 academic-shadow animate-in slide-in-from-right-10 z-50">
          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
          Jurnal actualizat la secundă...
        </div>
      )}
    </div>
  );
};

export default App;
