
import React from 'react';

interface MullerAvatarProps {
  isSpeaking: boolean;
  isListening: boolean;
  status: string;
}

const MullerAvatar: React.FC<MullerAvatarProps> = ({ isSpeaking, isListening, status }) => {
  return (
    <div className="relative flex items-center justify-center w-60 h-60 mx-auto mb-6">
      {/* Subtle pulse for active session */}
      {isListening && (
        <div className="absolute inset-0 bg-blue-100 rounded-full animate-pulse opacity-50"></div>
      )}

      {/* Main Avatar Circle */}
      <div className={`
        relative z-10 w-44 h-44 rounded-full flex items-center justify-center transition-all duration-500 border-4 academic-shadow
        ${isSpeaking ? 'scale-105 border-blue-600 bg-white' : 'bg-slate-50 border-slate-200'}
        ${status === 'ERROR' ? 'border-red-400 bg-red-50' : ''}
      `}>
        {/* Intellectual Face SVG */}
        <svg viewBox="0 0 100 100" className={`w-24 h-24 transition-colors duration-300 ${isSpeaking ? 'text-blue-700' : 'text-slate-600'}`}>
          {/* Eyeglasses */}
          <circle cx="35" cy="45" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <circle cx="65" cy="45" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <path d="M47 45 L53 45" stroke="currentColor" strokeWidth="2.5" />
          
          {/* Eyes */}
          <circle cx="35" cy="45" r="2.5" fill="currentColor" />
          <circle cx="65" cy="45" r="2.5" fill="currentColor" />
          
          {/* Professional Smile */}
          <path 
            d={isSpeaking ? "M 35 70 Q 50 80 65 70" : "M 40 70 Q 50 73 60 70"} 
            stroke="currentColor" 
            strokeWidth="3" 
            fill="transparent" 
            strokeLinecap="round" 
          />
        </svg>
      </div>

      {/* Discrete Audio Visualizer */}
      {isSpeaking && (
        <div className="absolute -bottom-2 flex gap-1 h-10 items-center">
          {[1, 2, 3, 4, 5].map((i) => (
            <div 
              key={i} 
              className="w-1.5 bg-blue-500 rounded-full animate-bounce" 
              // Fix: Moved 's' outside the template expression
              style={{ animationDelay: `${i * 0.1}s`, height: `${30 + Math.random() * 50}%` }}
            ></div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MullerAvatar;
