
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';
import { fetchAllConversations, saveConversation } from './services/supabase';
import FaneAvatar from './components/FaneAvatar';
import TranscriptionView from './components/TranscriptionView';

const BASE_SYSTEM_INSTRUCTION = `Ești Fane, moderatorul oficial și sufletul unui grup de băieți puși pe glume, ironii și caterincă. 
NU ești un asistent politicos, ci ești unul dintre ei – dar tu ești cel cu replicile la tine care ține grupul în frâu.

STILUL TĂU:
1. Fii spiritual, acid când e cazul și mereu gata de o glumă. Folosește jargon de gașcă (ex: "băieți", "măi", "fii atent aici").
2. Aruncă pastile: dacă cineva zice ceva banal, taxează-l cu umor.
3. JURNALUL DE PERLE: Consultă istoricul de mai jos. Amintește-le de glumele vechi sau de momentele când au dat-o în bară. 
4. Arbitrează: Dacă se ceartă în glumă, dă dreptate celui care are gluma mai bună.
5. Fii proactiv: Dacă e liniște, bagă tu o strâmbă sau întreabă-i ce au mai făcut.

CONTEXTUL TĂU DE MEMORIE:`;

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
      
      let contextStr = "\n\n### ARHIVA DE CATERINCĂ A GĂȘTII ###\n";
      
      if (history.length === 0) {
        contextStr += "Sunteți la prima ieșire virtuală. Salută-i cu entuziasm.\n";
      }

      history.forEach(entry => {
        contextStr += `--- ZIUA: ${entry.date} ---\n${entry.content}\n\n`;
        
        if (!isBackground && entry.date === todayStr && !fullConversationTextRef.current) {
          fullConversationTextRef.current = entry.content;
          const parsed = entry.content.split('\n').filter(l => l.trim()).map(line => ({
            text: line.replace(/^\[\d{2}:\d{2}\]\s*(Gașca:|Fane:)\s*/, ''),
            isUser: line.includes('Gașca:'),
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
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } }, // Puck is more energetic
          systemInstruction: `${BASE_SYSTEM_INSTRUCTION}\n${allHistoryContextRef.current}`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
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
                fullConversationTextRef.current += `${ts} Gașca: ${u}\n`;
                setTranscription(prev => [...prev, { text: u, isUser: true, timestamp: Date.now() }]);
              }
              if (m) {
                fullConversationTextRef.current += `${ts} Fane: ${m}\n`;
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
    <div className="min-h-screen flex flex-col bg-slate-950 p-4 md:p-8">
      <header className="w-full max-w-5xl mx-auto flex justify-between items-center mb-6">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-[0_0_15px_rgba(79,70,229,0.5)]">
            <span className="text-2xl font-black text-white italic">F</span>
          </div>
          <div>
            <h1 className="text-3xl font-black text-white tracking-tighter uppercase italic">Fane <span className="text-indigo-500">Live</span></h1>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-400 animate-pulse' : 'bg-slate-600'}`}></span>
              <p className="text-slate-500 font-bold uppercase text-[10px] tracking-widest">
                {status === ConnectionStatus.CONNECTED ? 'Grup activ' : 'Server Offline'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {isMemoryRefreshing && <div className="text-indigo-400 font-bold animate-pulse text-xs tracking-widest uppercase">Syncing Perle...</div>}
          {lastMemoryUpdate && <div className="text-slate-500 text-xs font-mono">DB v2.5 | {lastMemoryUpdate}</div>}
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto flex flex-col">
        {status === ConnectionStatus.IDLE || status === ConnectionStatus.ERROR ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <h2 className="text-6xl md:text-8xl font-black text-white mb-6 tracking-tighter leading-tight uppercase">
              Ce ziceți, <br/><span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 to-purple-500">Măi Băieți?</span>
            </h2>
            <p className="text-xl text-slate-400 mb-10 max-w-lg font-medium">Fane e pregătit pentru o doză proaspătă de caterincă. Cine are curaj să înceapă?</p>
            
            <button 
              onClick={connect}
              disabled={isLoadingMemories}
              className={`group relative overflow-hidden px-16 py-8 rounded-full transition-all active:scale-95 ${isLoadingMemories ? 'bg-slate-800' : 'bg-indigo-600 hover:bg-indigo-500'}`}
            >
              <span className="relative z-10 text-3xl font-black text-white uppercase italic">
                {isLoadingMemories ? 'Se încarcă gașca...' : 'Dă-i drumul!'}
              </span>
              <div className="absolute inset-0 bg-gradient-to-r from-indigo-400 to-purple-500 opacity-0 group-hover:opacity-20 transition-opacity"></div>
            </button>
            {status === ConnectionStatus.ERROR && <p className="mt-6 text-red-500 font-bold uppercase tracking-widest">Server Error. Mai bagă o fise!</p>}
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-6">
            <FaneAvatar isSpeaking={isSpeaking} isListening={isListening} status={status} />
            <TranscriptionView items={transcription} />
            <div className="flex justify-center pb-4">
              <div className="bg-slate-900/80 border border-slate-800 px-8 py-4 rounded-full flex items-center gap-3">
                <div className="w-2 h-2 bg-indigo-500 rounded-full animate-ping"></div>
                <span className="text-slate-400 font-bold text-sm uppercase tracking-widest">Vă ascultă Fane...</span>
              </div>
            </div>
          </div>
        )}
      </main>
      
      {isSaving && (
        <div className="fixed bottom-6 right-6 bg-green-500 text-slate-950 px-5 py-2 rounded-full text-xs font-black uppercase tracking-widest flex items-center gap-2 shadow-[0_0_15px_rgba(34,197,94,0.3)]">
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Update Arhivă Perle
        </div>
      )}
    </div>
  );
};

export default App;
