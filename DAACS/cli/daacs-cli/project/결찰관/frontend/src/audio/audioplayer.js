let audioContext = null;
let currentSource = null;

// Initialize AudioContext if not already initialized
const initAudioContext = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
};

/**
 * Plays Base64 encoded audio.
 * @param {string} base64String The Base64 audio data (e.g., "data:audio/mpeg;base64,...").
 * @param {function} onEnded Callback function to execute when audio finishes playing.
 */
export const playBase64Audio = async (base64String, onEnded = () => {}) => {
  initAudioContext();

  // Stop any currently playing audio
  stopAudio();

  const base64WithoutPrefix = base64String.split(',')[1];
  const audioBlob = base64toBlob(base64WithoutPrefix, getMimeType(base64String));

  const arrayBuffer = await audioBlob.arrayBuffer();

  audioContext.decodeAudioData(arrayBuffer, (buffer) => {
    currentSource = audioContext.createBufferSource();
    currentSource.buffer = buffer;
    currentSource.connect(audioContext.destination);
    currentSource.start(0);

    currentSource.onended = () => {
      currentSource = null;
      onEnded();
    };
  }, (e) => {
    console.error("Error decoding audio data", e);
    onEnded(); // Ensure onEnded is called even on error
  });
};

/**
 * Plays an audio file from a URL.
 * @param {string} url The URL of the audio file.
 * @param {function} onEnded Callback function to execute when audio finishes playing.
 */
export const playAudioFromUrl = (url, onEnded = () => {}) => {
  initAudioContext();

  stopAudio();

  currentSource = new Audio(url);
  currentSource.onended = () => {
    currentSource = null;
    onEnded();
  };
  currentSource.play().catch(e => {
    console.error("Error playing audio from URL", e);
    onEnded();
  });
};


/**
 * Stops the currently playing audio.
 */
export const stopAudio = () => {
  if (currentSource) {
    if (currentSource instanceof AudioBufferSourceNode) {
      currentSource.stop();
    } else if (currentSource instanceof Audio) {
      currentSource.pause();
      currentSource.currentTime = 0;
    }
    currentSource = null;
  }
};

/**
 * Converts a Base64 string to a Blob.
 * @param {string} base64 The Base64 string.
 * @param {string} mimeType The MIME type of the audio.
 * @returns {Blob} The audio Blob.
 */
const base64toBlob = (base64, mimeType) => {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
};

/**
 * Extracts MIME type from a Base64 string with a data URI prefix.
 * @param {string} base64String The full Base64 string (e.g., "data:audio/mpeg;base64,...").
 * @returns {string} The MIME type.
 */
const getMimeType = (base64String) => {
  const match = base64String.match(/^data:(.*?);base64,/);
  return match ? match[1] : 'application/octet-stream'; // Default if not found
};
