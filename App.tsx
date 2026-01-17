
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';
import { fetchAllConversations, saveConversation } from './services/supabase';
import MullerAvatar from './components/FaneAvatar';
import TranscriptionView from './components/TranscriptionView';

const CURRICULUM_DATA = `
DATE DE INITIALIZARE (PROGRAMA):
1. Gramatică: Diferența "Man soll" vs "Man sollte", întrebări indirecte (ob/wie lange), conectori temporali (nachdem, sobald, bis).
2. Vocabular B2.2: Context academic (Bologna, Heidelberg), carieră (die Qual der Wahl, unter Druck stehen).
3. Expresii Fixe (NVV): in Erfüllung gehen, Rücksicht nehmen, einen Entschluss fassen, zum Einsatz kommen.
4. Tematici Sociale: Prietenia (sich bewähren, Geborgenheit), stima de sine (Einfluss haben auf), HR (Arbeitsbedingungen, Aufstiegschancen).
5. Adverbe de Timp: vorhin, neulich, davor, demnächst, ab und zu.
`;

const BASE_SYSTEM_INSTRUCTION = `Ești Herr Müller, un profesor de germană empatic și structurat.

### PROTOCOLUL DE START ###
1. **Prezentare & Identificare**: Salută-l pe student ("Guten Tag! Ich bin Herr Müller") și cere-i numele pentru a-i deschide dosarul academic.
2. **Propunere Flexibilă**: După identificare, menționează că poți preda orice din programa academică (Gramatică, NVV-uri, Lumea Profesională sau Psihologia Relațiilor). 
3. **Sugestii (Opționale)**: Fă 2-3 propuneri concrete bazate pe datele de inițializare (ex: "Am putea discuta despre expresiile fixe precum 'in Erfüllung gehen' sau despre folosirea corectă a conectorilor temporali").
4. **Decizia Studentului**: Întreabă studentul: "Was möchten Sie heute lernen? Ce doriți să studiem astăzi?". Așteaptă decizia lui; nu este obligat să aleagă propunerile tale.

STIL DE PREDARE:
- Dacă studentul alege un subiect, începe cu o scurtă explicație teoretică și apoi treci la exerciții practice (dialog).
- Corectează greșelile de gramatică imediat, folosind numele studentului.

${CURRICULUM_DATA}

### ARHIVA DOSARELOR ACADEMICE (Istoric) ###`;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingMemories, setIsLoadingMemories] = useState(true);
  const [isMemoryRefreshing, setIsMemoryRefreshing] = useState(false);
  const [lastMemoryUpdate, setLastMemoryUpdate] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionPart[]>([]);
  
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
    return `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}]`;
  };

  const syncMemories = async (isBackground = false) => {
    if (isBackground) setIsMemoryRefreshing(true);
    else setIsLoadingMemories(true);

    try {
      const history = await fetchAllConversations();
      const todayStr = new Date().toISOString().split('T')[0];
      
      let contextStr = "\n\n### ISTORIC STUDENTI ###\n";
      
      history.forEach(entry => {
        contextStr += `--- DATA: ${entry.date} ---\n${entry.content}\n\n`;
        
        if (!isBackground && entry.date === todayStr && !fullConversationTextRef.current) {
          fullConversationTextRef.current = entry.content;
          const parsed = entry.content.split('\n').filter(l => l.trim()).map(line => ({
            text: line.replace(/^\[\d{2}:\d{2}\]\s*(Student:|Prof\. Müller:)\s*/, ''),
            isUser: line.includes('Student:'),
            timestamp: Date.now()
          }));
          setTranscription(parsed);
        }
      });
      
      allHistoryContextRef.current = contextStr;
      setLastMemoryUpdate(new Date().toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' }));
    } catch (err) {
      console.error("Eroare memorie:", err);
    } finally {
      setIsLoadingMemories(false);
      setTimeout(() => setIsMemoryRefreshing(false), 3000);
    }
  };

  useEffect(() => { syncMemories(); }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (status === ConnectionStatus.IDLE) syncMemories(true);
    }, 120000);
    return () => clearInterval(interval);
  }, [status]);

  useEffect(() => {
    let lastSaved = fullConversationTextRef.current;
    const timer = setInterval(async () => {
      const current = fullConversationTextRef.current;
      if (current && current !== lastSaved) {
        setIsSaving(true);
        try {
          await saveConversation(current);
          lastSaved = current;
        } finally {
          setTimeout(() => setIsSaving(false), 2000);
        }
      }
    }, 15000);
    return () => clearInterval(timer);
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
            
            // Trigger proactiv: Salutul și cererea numelui
            sessionPromise.then(s => {
              s.sendRealtimeInput({ media: { data: "", mimeType: 'audio/pcm;rate=16000' } });
            });

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
              if (u) {
                fullConversationTextRef.current += `${ts} Student: ${u}\n`;
                setTranscription(prev => [...prev, { text: u, isUser: true, timestamp: Date.now() }]);
              }
              if (m) {
                fullConversationTextRef.current += `${ts} Prof. Müller: ${m}\n`;
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
          onclose: () => setStatus(ConnectionStatus.IDLE)
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
              <p className="text-slate-500 font-semibold uppercase text-xs tracking-widest">
                {status === ConnectionStatus.CONNECTED ? 'Lecție individuală' : 'Academia Müller'}
              </p>
            </div>
          </div>
        </div>

        <div className="hidden md:flex flex-col items-end gap-1">
          {isMemoryRefreshing && <div className="text-blue-600 font-bold animate-pulse text-[10px] tracking-widest uppercase">Consultăm programa...</div>}
          {lastMemoryUpdate && <div className="text-slate-400 text-xs font-medium uppercase italic">Sincronizat: {lastMemoryUpdate}</div>}
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto flex flex-col">
        {status === ConnectionStatus.IDLE || status === ConnectionStatus.ERROR ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <div className="mb-6 p-4 bg-blue-50 rounded-full inline-block">
              <span className="text-blue-700 font-bold text-lg px-6 py-2 italic uppercase tracking-wider">Lecție Flexibilă & Interactivă</span>
            </div>
            <h2 className="text-5xl md:text-7xl font-bold text-slate-900 mb-6 tracking-tight leading-tight">
              Alegeți orice temă <br/><span className="text-blue-700">pentru astăzi.</span>
            </h2>
            <p className="text-xl text-slate-500 mb-10 max-w-2xl font-medium italic">Herr Müller vă va face câteva sugestii bazate pe programa B2.2, dar decizia finală vă aparține. Sunteți gata să începeți?</p>
            
            <button 
              onClick={connect}
              disabled={isLoadingMemories}
              className={`group relative overflow-hidden px-16 py-8 rounded-3xl transition-all academic-shadow active:scale-95 ${isLoadingMemories ? 'bg-slate-200 cursor-wait' : 'bg-blue-700 hover:bg-blue-800'}`}
            >
              <span className="relative z-10 text-2xl font-bold text-white uppercase tracking-wide">
                {isLoadingMemories ? 'Se încarcă programa...' : 'Să începem Lecția'}
              </span>
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-6">
            <MullerAvatar isSpeaking={isSpeaking} isListening={isListening} status={status} />
            <TranscriptionView items={transcription} />
            <div className="flex justify-center pb-6">
              <div className="bg-white px-10 py-5 rounded-full flex items-center gap-4 academic-shadow border border-slate-100">
                <div className="w-3 h-3 bg-blue-600 rounded-full animate-ping"></div>
                <span className="text-slate-600 font-bold text-lg italic tracking-tight italic">Profesorul așteaptă propunerea dumneavoastră...</span>
              </div>
            </div>
          </div>
        )}
      </main>
      
      {isSaving && (
        <div className="fixed bottom-10 right-10 bg-white border border-slate-200 text-slate-800 px-8 py-4 rounded-2xl text-sm font-bold flex items-center gap-4 academic-shadow animate-in slide-in-from-right-10 z-50">
          <svg className="w-5 h-5 text-blue-600 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Salvare progres în dosar...
        </div>
      )}
    </div>
  );
};

export default App;
