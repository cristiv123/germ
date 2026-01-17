
import React from 'react';

interface FaneAvatarProps {
  isSpeaking: boolean;
  isListening: boolean;
  status: string;
}

const FaneAvatar: React.FC<FaneAvatarProps> = ({ isSpeaking, isListening, status }) => {
  return (
    <div className="relative flex items-center justify-center w-64 h-64 mx-auto mb-8">
      {/* Pulse rings - Neon Purple/Blue */}
      {isListening && (
        <>
          <div className="absolute inset-0 bg-purple-500 rounded-full animate-ping opacity-20"></div>
          <div className="absolute inset-4 bg-blue-500 rounded-full animate-pulse opacity-30"></div>
        </>
      )}

      {/* Main Avatar Circle */}
      <div className={`
        relative z-10 w-48 h-48 rounded-[3rem] flex items-center justify-center transition-all duration-500 border-4
        ${isSpeaking ? 'scale-105 shadow-[0_0_30px_rgba(99,102,241,0.6)] border-indigo-400 bg-indigo-900' : 'bg-slate-800 border-slate-700 shadow-xl'}
        ${status === 'ERROR' ? 'border-red-500 bg-red-900/20' : ''}
      `}>
        {/* Cool Face with Sunglasses SVG */}
        <svg viewBox="0 0 100 100" className="w-28 h-28 text-white fill-current">
          {/* Sunglasses */}
          <path d="M20 40 L45 40 L45 50 Q45 60 32.5 60 Q20 60 20 50 Z" />
          <path d="M55 40 L80 40 L80 50 Q80 60 67.5 60 Q55 60 55 50 Z" />
          <path d="M45 45 L55 45" stroke="white" strokeWidth="2" />
          {/* Smirk */}
          <path 
            d={isSpeaking ? "M 35 75 Q 50 85 70 70" : "M 40 75 Q 55 78 70 72"} 
            stroke="white" 
            strokeWidth="3" 
            fill="transparent" 
            strokeLinecap="round" 
          />
        </svg>
      </div>

      {/* Visualizer bars */}
      {isSpeaking && (
        <div className="absolute -bottom-4 flex gap-1.5 h-16 items-end">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div 
              key={i} 
              className="w-2 bg-gradient-to-t from-indigo-500 to-purple-400 rounded-full animate-bounce" 
              style={{ animationDelay: `${i * 0.05}s`, height: `${40 + Math.random() * 60}%` }}
            ></div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FaneAvatar;
