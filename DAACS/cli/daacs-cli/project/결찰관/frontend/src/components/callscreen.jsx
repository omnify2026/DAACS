import React, { useState, useEffect } from 'react';

function CallScreen({ onEndCall, status, error }) {
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setCallDuration((prevDuration) => prevDuration + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const formatTime = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const getStatusText = () => {
    if (error) {
      return error;
    }
    switch(status) {
      case 'intro':
        return '경찰관과 연결되었습니다...';
      case 'listening':
        return '말씀을 듣고 있습니다...';
      case 'responding':
        return '답변을 생성하는 중...';
      default:
        return '통화 중';
    }
  }

  return (
    <div className="flex flex-col justify-between min-h-screen bg-black text-white p-4 sm:p-6">
      {/* Top section: Carrier and Duration */}
      <div className="w-full text-center pt-8">
        <p className="text-base sm:text-lg font-light text-gray-300">경찰청</p>
        <p className="text-lg sm:text-xl font-medium mt-1">{formatTime(callDuration)}</p>
      </div>

      {/* Middle section: Call Info */}
      <div className="flex flex-col items-center text-center my-8">
        <h1 className="text-4xl sm:text-5xl font-light mb-2">경찰서</h1>
        <p className={`text-base sm:text-lg ${error ? 'text-red-500' : 'text-gray-300'}`}>{getStatusText()}</p>
      </div>

      {/* Bottom section: Controls */}
      <div className="flex flex-col items-center w-full max-w-xs sm:max-w-sm mx-auto">
        <div className="grid grid-cols-3 gap-x-6 sm:gap-x-8 w-full mb-8">
          {/* Mute Button */}
          <div className="flex flex-col items-center">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-75 ${
                isMuted ? 'bg-blue-600' : 'bg-gray-800'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 sm:h-10 sm:w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                {isMuted ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75v.25a6 6 0 01-6 6h-.25m-5.5 0a6.002 6.002 0 01-5.5-6v-.25m11.5 0v-2.25a.75.75 0 00-1.5 0v2.25m-2.5-4.5V3.75a.75.75 0 011.5 0v1.5m-3 .75a.75.75 0 00-1.5 0v.75m6 2.25a.75.75 0 00-1.5 0v.75M3.75 9.75a.75.75 0 00-1.5 0v.75M21 9.75v.25a6 6 0 01-6 6h-.25m-5.5 0a6.002 6.002 0 01-5.5-6v-.25m11.5 0v-2.25a.75.75 0 00-1.5 0v2.25m-2.5-4.5V3.75a.75.75 0 011.5 0v1.5m-3 .75a.75.75 0 00-1.5 0v.75m6 2.25a.75.75 0 00-1.5 0v.75M3.75 9.75a.75.75 0 00-1.5 0v.75" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75-3.75h7.5" />
                )}
              </svg>
            </button>
            <span className="text-sm sm:text-base mt-2 text-gray-300">음소거</span>
          </div>

          {/* Speaker Button */}
          <div className="flex flex-col items-center">
            <button
              onClick={() => setIsSpeakerOn(!isSpeakerOn)}
              className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-75 ${
                isSpeakerOn ? 'bg-blue-600' : 'bg-gray-800'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 sm:h-10 sm:w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-2.467-1.75-1.625 2.542-.369L12 13.5l1.125 2.25 2.542.369-1.75 1.625.569 2.467-2.51-2.225z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h7.5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 10.5h4.5" />
              </svg>
            </button>
            <span className="text-sm sm:text-base mt-2 text-gray-300">스피커</span>
          </div>

          {/* Keypad Button (Placeholder) */}
          <div className="flex flex-col items-center">
            <button className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gray-800 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-75">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 sm:h-10 sm:w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v.01M9 6v.01M9 9v.01M12 3v.01M12 6v.01M12 9v.01M15 3v.01M15 6v.01M15 9v.01M6 6v.01M6 9v.01M6 12v.01M9 12v.01M12 12v.01M15 12v.01M18 9v.01M18 12v.01" />
            </svg>
            </button>
            <span className="text-sm sm:text-base mt-2 text-gray-300">키패드</span>
          </div>
        </div>

        {/* End Call Button */}
        <button
          onClick={onEndCall}
          className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-red-500 flex items-center justify-center mt-4 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-opacity-75 transform transition-transform hover:scale-105"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 sm:h-12 sm:w-12 text-white transform rotate-[135deg]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
        </button>
        <span className="text-base sm:text-lg mt-3 text-white">통화 종료</span>
      </div>
    </div>
  );
}

export default CallScreen;
