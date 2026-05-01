import React, { useEffect, useState } from 'react';

// This component will play a connecting sound for 3 seconds and then call onCallConnected.
// For now, the sound is simulated with a delay.
function ConnectingScreen({ onCallConnected }) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    // Simulate connecting sound and delay
    const timer = setTimeout(() => {
      onCallConnected();
    }, 3000); // 3 seconds connecting sound

    // Animate dots for "연결 중"
    const dotInterval = setInterval(() => {
      setDots((prevDots) => {
        if (prevDots.length >= 3) return '';
        return prevDots + '.';
      });
    }, 500); // Add a dot every 500ms

    return () => {
      clearTimeout(timer);
      clearInterval(dotInterval);
    };
  }, [onCallConnected]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4">
      <div className="flex flex-col items-center justify-center h-full text-center">
        <p className="text-3xl sm:text-4xl md:text-5xl font-light text-gray-300 mb-4">전화 거는 중</p>
        <h1 className="text-5xl sm:text-6xl md:text-7xl font-light">경찰서</h1>
        <p className="text-2xl sm:text-3xl md:text-4xl font-light text-gray-300 mt-12">연결 중{dots}</p>
      </div>
    </div>
  );
}

export default ConnectingScreen;