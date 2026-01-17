
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
      className="flex-1 w-full max-w-4xl mx-auto overflow-y-auto px-8 py-10 space-y-6 bg-white rounded-3xl border border-slate-200 academic-shadow"
      style={{ maxHeight: '45vh' }}
    >
      {items.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center opacity-50 text-slate-400">
          <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          <p className="text-xl font-medium">Lecția de germană este gata să înceapă.</p>
        </div>
      ) : (
        items.map((item, idx) => (
          <div 
            key={idx} 
            className={`flex ${item.isUser ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
          >
            <div className={`
              max-w-[80%] px-6 py-4 chat-bubble border
              ${item.isUser 
                ? 'bg-slate-50 text-slate-800 border-slate-200 rounded-br-none' 
                : 'bg-blue-600 text-white border-blue-500 rounded-bl-none shadow-md'}
            `}>
              <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 opacity-70`}>
                {item.isUser ? 'Student' : 'Prof. Müller'}
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
