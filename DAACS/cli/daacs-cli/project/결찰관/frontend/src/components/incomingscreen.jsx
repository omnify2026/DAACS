import React, { useState } from 'react';

function IncomingScreen({ onStartCall }) {
  const [childName, setChildName] = useState('');
  const [situation, setSituation] = useState('');

  const handleStartClick = () => {
    if (childName.trim() && situation.trim()) {
      onStartCall(childName, situation);
    } else {
      alert('아이 이름과 잘못한 상황을 모두 입력해주세요.');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 sm:p-6">
      <div className="text-center">
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold mb-2 text-gray-100">경찰관과 통화</h1>
        <p className="text-lg sm:text-xl md:text-2xl text-gray-400 mb-8">아이 훈육을 위한 가상 통화</p>
      </div>
      
      <div className="w-full max-w-sm sm:max-w-md md:max-w-lg space-y-4">
        <input
          type="text"
          value={childName}
          onChange={(e) => setChildName(e.target.value)}
          placeholder="아이 이름"
          className="w-full px-4 py-3 min-h-[44px] bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-base sm:text-lg"
        />
        <textarea
          value={situation}
          onChange={(e) => setSituation(e.target.value)}
          placeholder="아이가 잘못한 상황을 간단히 설명해주세요. (예: 동생을 때렸어요)"
          rows="3"
          className="w-full px-4 py-3 min-h-[44px] bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-base sm:text-lg"
        />
      </div>
      
      <div className="mt-10 sm:mt-12">
        <button
          onClick={handleStartClick}
          className="w-24 h-24 sm:w-28 sm:h-28 md:w-32 md:h-32 rounded-full bg-green-500 flex items-center justify-center shadow-lg transform transition-transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-green-700 focus:ring-opacity-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 sm:h-14 sm:w-14 md:h-16 md:w-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
        </button>
        <span className="block text-center text-lg sm:text-xl text-gray-300 mt-3">통화 시작</span>
      </div>
    </div>
  );
}

export default IncomingScreen;