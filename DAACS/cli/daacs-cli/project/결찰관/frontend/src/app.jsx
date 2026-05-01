import React, { useState, useCallback, useEffect, useRef } from 'react';
import IncomingScreen from './components/IncomingScreen';
import ConnectingScreen from './components/ConnectingScreen';
import CallScreen from './components/CallScreen';
import { startCall, generateResponse } from './services/api';
import { playBase64Audio } from './audio/AudioPlayer';
import SpeechRecognizer from './speech/SpeechRecognizer';

// Define call states
const CALL_STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  INTRO: 'intro', // Police officer's first ment, AI is talking
  LISTENING: 'listening', // User is talking (STT active)
  RESPONDING: 'responding', // AI is processing/generating response
  ENDED: 'ended',
};

function App() {
  const [callStatus, setCallStatus] = useState(CALL_STATUS.IDLE);
  const [sessionId, setSessionId] = useState(null);
  const [childName, setChildName] = useState('');
  const [situationHint, setSituationHint] = useState('');
  const [error, setError] = useState(null);

  const speechRecognizer = useRef(null);

  const handleStartCall = useCallback(() => {
    // This is now triggered from the form inside IncomingScreen
    // It will set the name/situation and then change status
    setCallStatus(CALL_STATUS.CONNECTING);
  }, []);

  const handleCallConnected = useCallback(async () => {
    console.log("handleCallConnected triggered. childName:", childName, "situationHint:", situationHint);
    try {
      setError(null);
      const data = await startCall(childName, situationHint);
      console.log("startCall success. data:", data);
      // const data = {
      //   session_id: 'test-session-id',
      //   audio_mime: 'audio/mp3',
      //   audio_base64: '...dummy_base64_string...',
      // };
      setSessionId(data.session_id);
      console.log("Session ID set to:", data.session_id);
      setCallStatus(CALL_STATUS.INTRO);
      const audioSrc = `data:${data.audio_mime};base64,${data.audio_base64}`;
      playBase64Audio(audioSrc, () => {
        // After intro audio finishes, start listening for parent's speech
        setCallStatus(CALL_STATUS.LISTENING);
      });
    } catch (err) {
      console.error(err);
      setError(err.message);
      setCallStatus(CALL_STATUS.ENDED);
    }
  }, [childName, situationHint]);

  const handleEndCall = useCallback(() => {
    // Reset all state
    setSessionId(null);
    setChildName('');
    setSituationHint('');
    setError(null);
    if (speechRecognizer.current) {
      speechRecognizer.current.stop();
    }
    setCallStatus(CALL_STATUS.ENDED);
    // Add a delay before returning to the idle screen
    setTimeout(() => {
      setCallStatus(CALL_STATUS.IDLE);
    }, 1500);
  }, []);

  const handleParentSpeech = useCallback(async (parentText) => {
    if (!parentText || parentText.trim() === '') {
      console.warn("Empty speech input ignored.");
      return;
    }
    console.log("handleParentSpeech called with:", parentText, "SessionID:", sessionId, "ChildName:", childName);
    try {
      const data = await generateResponse(sessionId, childName, parentText);
      // const data = {
      //   audio_mime: 'audio/mp3',
      //   audio_base64: '...dummy_base64_string...',
      // };
      const audioSrc = `data:${data.audio_mime};base64,${data.audio_base64}`;
      playBase64Audio(audioSrc, () => setCallStatus(CALL_STATUS.LISTENING));
    } catch (err) {
      console.error(err);
      setError(err.message);
      setCallStatus(CALL_STATUS.LISTENING); // Go back to listening on error
    }
  }, [sessionId, childName]);

  // Initialize Speech Recognizer
  useEffect(() => {
    speechRecognizer.current = new SpeechRecognizer('ko-KR');

    speechRecognizer.current.onError = (error) => {
      console.error('STT Error:', error);
      setError('음성 인식에 실패했습니다. 다시 시도해 주세요.');
      // After a short delay, go back to listening
      setTimeout(() => {
        setError(null);
        setCallStatus(CALL_STATUS.LISTENING);
      }, 2000);
    };
  }, []);

  // Update onResult handler when handleParentSpeech changes (to capture new state)
  useEffect(() => {
    if (speechRecognizer.current) {
      speechRecognizer.current.onResult = (transcript) => {
        setCallStatus(CALL_STATUS.RESPONDING);
        handleParentSpeech(transcript);
      };
    }
  }, [handleParentSpeech]);

  // Effect to manage call flow state transitions
  useEffect(() => {
    if (callStatus === CALL_STATUS.LISTENING) {
      speechRecognizer.current?.start();
    } else {
      speechRecognizer.current?.stop();
    }
  }, [callStatus]);



  const renderScreen = () => {
    switch (callStatus) {
      case CALL_STATUS.IDLE:
        return (
          <IncomingScreen
            onStartCall={(name, situation) => {
              setChildName(name);
              setSituationHint(situation);

              handleStartCall();
            }}
          />
        );
      case CALL_STATUS.CONNECTING:
        return <ConnectingScreen onCallConnected={handleCallConnected} />;
      case CALL_STATUS.INTRO:
      case CALL_STATUS.LISTENING:
      case CALL_STATUS.RESPONDING:
        return (
          <CallScreen
            onEndCall={handleEndCall}
            status={callStatus}
            error={error}
          />
        );
      case CALL_STATUS.ENDED:
        return (
          <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 text-center">
            <h1 className="text-4xl sm:text-5xl font-bold mb-4">통화 종료</h1>
            {error && <p className="text-red-500 mb-4">{error}</p>}
          </div>
        );
      default:
        return null;
    }
  };

  return <div className="App bg-black min-h-screen">{renderScreen()}</div>;
}

export default App;