
import React, { useEffect, useRef } from 'react';
import { TranscriptionPart } from '../types';

interface TranscriptionViewProps {
  items: TranscriptionPart[];
}

const TranscriptionView: React.FC<TranscriptionViewProps> = ({ items }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items]);

  return (
    <div 
      ref={scrollRef}
      className="flex-1 w-full max-w-4xl mx-auto overflow-y-auto px-6 py-8 space-y-6 bg-slate-800/40 rounded-3xl border border-slate-700/50"
      style={{ maxHeight: '45vh' }}
    >
      {items.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center opacity-40">
          <p className="text-blue-300 italic text-xl">Fane e pe recepție. Cine dă prima glumă?</p>
        </div>
      ) : (
        items.map((item, idx) => (
          <div 
            key={idx} 
            className={`flex ${item.isUser ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
          >
            <div className={`
              max-w-[80%] px-6 py-3 chat-bubble shadow-lg border
              ${item.isUser 
                ? 'bg-slate-700 text-blue-100 border-slate-600 rounded-tr-none' 
                : 'bg-indigo-600 text-white border-indigo-500 rounded-tl-none neon-border'}
            `}>
              <p className="text-xs font-bold uppercase tracking-wider opacity-50 mb-1">
                {item.isUser ? 'Gașca' : 'Fane'}
              </p>
              {item.text}
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default TranscriptionView;
