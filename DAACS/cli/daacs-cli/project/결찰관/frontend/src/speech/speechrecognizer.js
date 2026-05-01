/**
 * SpeechRecognizer class to wrap the Web Speech API for voice input.
 * Provides methods to start and stop recognition, and handles events for results and errors.
 * If Web Speech API is not supported, it will indicate that through isSupported property.
 */
class SpeechRecognizer {
  constructor(lang = 'ko-KR') {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    this.isSupported = !!SpeechRecognition;
    this.recognition = null;
    this.lang = lang;

    if (this.isSupported) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false; // Stop after first result
      this.recognition.interimResults = false; // Only return final results
      this.recognition.lang = this.lang;

      // Event handlers (can be overridden by the consumer)
      this.onResult = () => { };
      this.onError = () => { };
      this.onStart = () => { };
      this.onEnd = () => { };

      this.recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        this.onResult(transcript);
      };

      this.recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        this.onError(event.error);
      };

      this.recognition.onstart = () => {
        this.isListening = true;
        this.onStart();
      };

      this.recognition.onend = () => {
        this.isListening = false;
        this.onEnd();
      };
    } else {
      console.warn("Web Speech API is not supported in this browser. Text input fallback will be necessary.");
    }
  }

  /**
   * Starts speech recognition.
   * @returns {boolean} True if recognition started, false otherwise (e.g., not supported).
   */
  start() {
    if (this.isSupported && this.recognition) {
      if (this.isListening) {
        console.warn("Speech recognition is already active.");
        return true;
      }
      try {
        this.recognition.start();
        this.isListening = true;
        return true;
      } catch (e) {
        if (e.name === 'InvalidStateError') {
          console.warn("Speech recognition already started (caught InvalidStateError).");
          this.isListening = true;
          return true;
        }
        console.error("Error starting speech recognition:", e);
        this.onError('recognition_failed');
        return false;
      }
    }
    return false;
  }

  stop() {
    if (this.isSupported && this.recognition) {
      try {
        this.recognition.stop();
        this.isListening = false;
      } catch (e) {
        // Ignore stop errors
      }
    }
  }

  /**
   * Sets the language for speech recognition.
   * @param {string} lang Language tag (e.g., 'ko-KR', 'en-US').
   */
  setLang(lang) {
    if (this.isSupported && this.recognition) {
      this.lang = lang;
      this.recognition.lang = lang;
    }
  }
}

export default SpeechRecognizer;